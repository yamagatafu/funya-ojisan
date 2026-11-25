import type { RESTPostAPIChannelMessageJSONBody } from 'discord-api-types/v10';
import { $channels$_$messages, $channels$_$messages$_, type createRest } from 'discord-hono';
import type { DbStatement, ReminderDb } from '../types.ts';
import { MINUTE_MS } from './date.ts';
import { buildNotification, buildPreNotification, type MessagePayload } from './message.ts';
import {
	cancelPendingJobsStatement,
	claimJob,
	cleanupExpired,
	closeOccurrenceStatement,
	type ExtraCondition,
	findDueJobs,
	findRemindersWithoutSchedule,
	getJob,
	getOccurrence,
	getReminder,
	insertJobStatement,
	insertOccurrence,
	type JobRow,
	jobOwnershipCondition,
	listOpenOccurrences,
	type OccurrenceRow,
	type ReminderRow,
	recordJobSentMessage,
	updateJob,
	updateJobStatement,
	updateOccurrence,
	updateOccurrenceStatement,
	updateReminderStatement,
} from './repository.ts';
import { planUpcoming } from './service.ts';

export type Rest = ReturnType<typeof createRest>;

const BATCH_SIZE = 50;
/** 1 回の Cron 実行でジョブ処理に使う時間の上限 */
const EXECUTION_BUDGET_MS = 40_000;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = MINUTE_MS;

export type SendOutcome =
	| { type: 'ok'; messageId: string }
	| { type: 'rate_limited'; retryAfterMs: number }
	| { type: 'transient'; detail: string }
	| { type: 'permanent'; detail: string };

async function retryAfterMs(response: { headers: Headers; json(): Promise<unknown> }): Promise<number> {
	const header = Number(response.headers.get('retry-after'));
	if (Number.isFinite(header) && header > 0) {
		return Math.ceil(header * 1000);
	}
	try {
		const body: unknown = await response.json();
		if (typeof body === 'object' && body !== null && 'retry_after' in body) {
			const seconds = Number(body.retry_after);
			if (Number.isFinite(seconds) && seconds > 0) {
				return Math.ceil(seconds * 1000);
			}
		}
	} catch {
		// JSON でなければ既定値
	}
	return RETRY_DELAY_MS;
}

/** ジョブごとの nonce。Discord は同じ nonce の投稿を数分間 1 件にまとめるため、再試行時の二重投稿を防げる */
export function jobNonce(jobId: number): string {
	return `reminder-job-${jobId}`;
}

export async function postMessage(
	rest: Rest,
	channelId: string,
	payload: MessagePayload,
	nonce?: string,
): Promise<SendOutcome> {
	let response: Awaited<ReturnType<Rest>>;
	try {
		response = await rest(
			'POST',
			$channels$_$messages,
			[channelId],
			(nonce
				? { ...payload, nonce, enforce_nonce: true }
				: payload) as unknown as RESTPostAPIChannelMessageJSONBody,
		);
	} catch (error) {
		return { type: 'transient', detail: String(error) };
	}

	if (response.ok) {
		const body: unknown = await response.json().catch(() => null);
		const messageId =
			typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string' ? body.id : null;
		return messageId ? { type: 'ok', messageId } : { type: 'transient', detail: 'response has no message id' };
	}
	if (response.status === 429) {
		return { type: 'rate_limited', retryAfterMs: await retryAfterMs(response) };
	}
	const text = await response.text().catch(() => '');
	const detail = `status=${response.status} ${text}`.slice(0, 500);
	return response.status >= 500 ? { type: 'transient', detail } : { type: 'permanent', detail };
}

/** メッセージのボタンを外す (失敗しても処理は続ける) */
export async function removeButtons(rest: Rest, channelId: string, messageId: string | null): Promise<void> {
	if (!messageId) {
		return;
	}
	try {
		const response = await rest('PATCH', $channels$_$messages$_, [channelId, messageId], { components: [] });
		if (!response.ok && response.status !== 404) {
			console.error('Failed to remove reminder buttons:', channelId, messageId, response.status);
		}
	} catch (error) {
		console.error('Unexpected error while removing reminder buttons:', channelId, messageId, error);
	}
}

interface DispatchContext {
	db: ReminderDb;
	rest: Rest;
	now: () => number;
}

/**
 * 確保したジョブ (locked_at は確保した時刻)。
 * ジョブへの書き込みは、今もこの実行がロックを持っている場合だけ行う (ownership)。
 */
type ClaimedJob = JobRow & { locked_at: number };

function owned(job: ClaimedJob): ExtraCondition {
	return jobOwnershipCondition(job.id, job.locked_at);
}

/** 失敗時の状態の確定 (giveUp の batch) 自体が失敗したことを表す。状態は確定していないため、ジョブを再試行に回す */
class StateTransitionError extends Error {
	constructor(cause: unknown) {
		super(`Failed to record the reminder job failure: ${String(cause)}`);
		this.name = 'StateTransitionError';
	}
}

async function finishJob(ctx: DispatchContext, job: ClaimedJob, status: 'sent' | 'cancelled'): Promise<void> {
	await updateJob(ctx.db, job.id, { status }, ctx.now(), owned(job));
}

/**
 * ジョブを諦める。状態の更新は 1 つの batch で行う。
 * - 恒久エラー、または本通知を諦める場合は、リマインダを error にして以降の送信を止める
 *   (有効なまま予定のないリマインダを残さず、/remind list で気付けるようにする)
 * - それ以外 (事前通知・再通知・スヌーズの一時的な失敗) は、そのジョブだけを failed にする
 * batch が失敗した場合は StateTransitionError を投げる。呼び出し側はジョブを再試行できる状態に戻すこと。
 */
async function giveUp(
	ctx: DispatchContext,
	job: ClaimedJob,
	params: { detail: string; disableReminder: boolean; occurrenceId: number | null },
): Promise<void> {
	const now = ctx.now();
	const attempts = job.attempt_count + 1;
	const disable = params.disableReminder || job.kind === 'main';
	console.error(
		`[ALERT] Reminder job given up${disable ? ' and reminder disabled' : ''}: jobId=${job.id}, reminderId=${job.reminder_id}, attempts=${attempts}, ${params.detail}`,
	);
	// ジョブの更新はロックを外すため最後に行う (先に行うと、所有権を条件にした以降の文が反映されない)
	const statements = compact([
		disable
			? updateReminderStatement(
					ctx.db,
					job.reminder_id,
					{ status: 'error', last_error: params.detail.slice(0, 500), next_run_at: null },
					now,
					owned(job),
				)
			: null,
		disable ? cancelPendingJobsStatement(ctx.db, { reminderId: job.reminder_id }, now) : null,
		disable && params.occurrenceId !== null
			? closeOccurrenceStatement(ctx.db, params.occurrenceId, 'superseded', { now })
			: null,
		updateJobStatement(ctx.db, job.id, { status: 'failed', attempt_count: attempts }, now, owned(job)),
	]);
	try {
		await ctx.db.batch(statements);
	} catch (error) {
		throw new StateTransitionError(error);
	}
}

/** ジョブを再試行できる状態に戻す */
async function retryLater(
	ctx: DispatchContext,
	job: ClaimedJob,
	delayMs: number,
	countAttempt: boolean,
): Promise<void> {
	const now = ctx.now();
	await updateJob(
		ctx.db,
		job.id,
		{
			status: 'pending',
			run_at: now + delayMs,
			attempt_count: countAttempt ? job.attempt_count + 1 : job.attempt_count,
		},
		now,
		owned(job),
	);
}

async function handleSendFailure(
	ctx: DispatchContext,
	job: ClaimedJob,
	outcome: Exclude<SendOutcome, { type: 'ok' }>,
	occurrenceId: number | null,
): Promise<void> {
	switch (outcome.type) {
		case 'rate_limited':
			await retryLater(ctx, job, outcome.retryAfterMs, false);
			return;
		case 'transient':
			if (job.attempt_count + 1 >= MAX_ATTEMPTS) {
				await giveUp(ctx, job, { detail: outcome.detail, disableReminder: false, occurrenceId });
				return;
			}
			console.error(
				`Reminder job failed transiently (attempt ${job.attempt_count + 1}): jobId=${job.id}, ${outcome.detail}`,
			);
			await retryLater(ctx, job, RETRY_DELAY_MS, true);
			return;
		case 'permanent':
			// チャンネル削除・権限不足など
			await giveUp(ctx, job, { detail: outcome.detail, disableReminder: true, occurrenceId });
			return;
	}
}

async function processPreJob(ctx: DispatchContext, job: ClaimedJob, reminder: ReminderRow): Promise<void> {
	if (reminder.status !== 'active' || ctx.now() >= job.scheduled_at) {
		// 一時停止中、または本通知の時刻を過ぎた事前通知は送らない
		await finishJob(ctx, job, 'cancelled');
		return;
	}
	const outcome = await postMessage(
		ctx.rest,
		reminder.channel_id,
		buildPreNotification(reminder, job.scheduled_at),
		jobNonce(job.id),
	);
	if (outcome.type === 'ok') {
		await finishJob(ctx, job, 'sent');
	} else {
		await handleSendFailure(ctx, job, outcome, null);
	}
}

/** 送信済みの通知メッセージ (ボタンを外す対象) */
interface SentMessage {
	channelId: string;
	messageId: string | null;
}

/** 回の通知を送ったチャンネル。migrations/0003 以前の行はリマインダの通知先を使う */
function occurrenceChannelId(occurrence: Pick<OccurrenceRow, 'channel_id'>, reminder: ReminderRow): string {
	return occurrence.channel_id ?? reminder.channel_id;
}

function sentMessageOf(occurrence: OccurrenceRow, reminder: ReminderRow): SentMessage {
	return { channelId: occurrenceChannelId(occurrence, reminder), messageId: occurrence.last_message_id };
}

/** 再通知ジョブを登録する SQL 文 (上限に達していれば null) */
function nagStatement(
	ctx: DispatchContext,
	reminder: ReminderRow,
	occurrence: Pick<OccurrenceRow, 'id' | 'scheduled_at'>,
	nagCount: number,
	condition: ExtraCondition,
): DbStatement | null {
	if (!reminder.nag_interval_minutes || nagCount >= (reminder.nag_max_count ?? 0)) {
		return null;
	}
	const now = ctx.now();
	return insertJobStatement(
		ctx.db,
		{
			reminderId: reminder.id,
			occurrenceId: occurrence.id,
			kind: 'nag',
			runAt: now + reminder.nag_interval_minutes * MINUTE_MS,
			scheduledAt: occurrence.scheduled_at,
		},
		now,
		condition,
	);
}

/** 前の回の通知を置き換え済みにし、再通知・スヌーズを止める SQL 文と、ボタンを外す対象のメッセージ */
async function planSupersede(
	ctx: DispatchContext,
	reminder: ReminderRow,
	keepId: number,
): Promise<{ statements: DbStatement[]; messages: SentMessage[] }> {
	const statements: DbStatement[] = [];
	const messages: SentMessage[] = [];
	const now = ctx.now();
	for (const occurrence of await listOpenOccurrences(ctx.db, reminder.id)) {
		if (occurrence.id === keepId) {
			continue;
		}
		statements.push(
			closeOccurrenceStatement(ctx.db, occurrence.id, 'superseded', { now }),
			cancelPendingJobsStatement(
				ctx.db,
				{ reminderId: reminder.id, occurrenceId: occurrence.id, kinds: ['nag', 'snooze'] },
				now,
			),
		);
		messages.push(sentMessageOf(occurrence, reminder));
	}
	return { statements, messages };
}

function compact(statements: (DbStatement | null)[]): DbStatement[] {
	return statements.filter((statement): statement is DbStatement => statement !== null);
}

async function processMainJob(ctx: DispatchContext, job: ClaimedJob, reminder: ReminderRow): Promise<void> {
	if (reminder.status !== 'active') {
		await finishJob(ctx, job, 'cancelled');
		return;
	}

	// 前回の実行が送信後に中断していた場合は、送信済みの通知を使い回す (二重送信の防止)
	let occurrence = job.occurrence_id !== null ? await getOccurrence(ctx.db, job.occurrence_id) : null;
	if (!occurrence) {
		const occurrenceId = await insertOccurrence(ctx.db, reminder.id, job.scheduled_at, reminder.channel_id);
		await ctx.db
			.prepare('UPDATE reminder_jobs SET occurrence_id = ? WHERE id = ?')
			.bind(occurrenceId, job.id)
			.run();
		occurrence = await getOccurrence(ctx.db, occurrenceId);
		if (!occurrence) {
			throw new Error(`Occurrence ${occurrenceId} disappeared`);
		}
	}

	if (!occurrence.last_message_id) {
		// 再試行時も、回に記録したチャンネルに送る (記録と実際の送信先を一致させる)
		const outcome = await postMessage(
			ctx.rest,
			occurrenceChannelId(occurrence, reminder),
			buildNotification(reminder, {
				kind: 'main',
				occurrenceId: occurrence.id,
				scheduledAt: job.scheduled_at,
				now: ctx.now(),
			}),
			jobNonce(job.id),
		);
		if (outcome.type !== 'ok') {
			await handleSendFailure(ctx, job, outcome, occurrence.id);
			return;
		}
		await updateOccurrence(ctx.db, occurrence.id, { last_message_id: outcome.messageId });
	}

	// 送信後の処理は 1 つの batch (トランザクション) で行う。
	// 途中で失敗しても何も反映されないため、再試行で重複登録や残り回数の二重減算が起きない
	const now = ctx.now();
	const remainingCount = reminder.remaining_count === null ? null : Math.max(0, reminder.remaining_count - 1);
	const supersede = await planSupersede(ctx, reminder, occurrence.id);
	// 次回の予定・残り回数・終了状態は、ジョブ取得時に読んだ内容から変更されていない場合だけ反映する。
	// 処理中に編集・一時停止された場合は、編集側で登録した予定を優先する (古い内容で上書きしない)
	const upcoming = planUpcoming(
		ctx.db,
		{ ...reminder, remaining_count: remainingCount },
		Math.max(job.scheduled_at, now),
		now,
		{
			guardRevision: reminder.revision,
			// ロックが切れて別の実行に再取得されていた場合は、この実行の結果を書き込まない (次回ジョブの重複登録の防止)
			condition: owned(job),
			extraUpdate: remainingCount === null ? undefined : { remaining_count: remainingCount },
		},
	);
	await ctx.db.batch(
		compact([
			...supersede.statements,
			nagStatement(ctx, reminder, occurrence, occurrence.nag_count, owned(job)),
			...upcoming.statements,
			updateJobStatement(ctx.db, job.id, { status: 'sent' }, now, owned(job)),
		]),
	);

	for (const message of supersede.messages) {
		await removeButtons(ctx.rest, message.channelId, message.messageId);
	}
}

async function processFollowUpJob(ctx: DispatchContext, job: ClaimedJob, reminder: ReminderRow): Promise<void> {
	const occurrence = job.occurrence_id !== null ? await getOccurrence(ctx.db, job.occurrence_id) : null;
	// error のリマインダ (送信先に投稿できない) には送らない。ended は開いている回の再通知が必要なため送る
	if (occurrence?.state !== 'open' || reminder.status === 'error') {
		await finishJob(ctx, job, 'cancelled');
		return;
	}

	const isNag = job.kind === 'nag';
	const nagCount = isNag ? occurrence.nag_count + 1 : occurrence.nag_count;
	if (isNag && nagCount > (reminder.nag_max_count ?? 0)) {
		// 上限を超える再通知は送らない
		await finishJob(ctx, job, 'cancelled');
		return;
	}

	// 前回の実行が送信後に中断していた場合は、送信済みのメッセージを使い回す (再送の防止)
	// 再通知・スヌーズは、その回の通知を送ったチャンネルに送る
	const channelId = occurrenceChannelId(occurrence, reminder);
	let messageId = job.sent_message_id;
	if (!messageId) {
		const outcome = await postMessage(
			ctx.rest,
			channelId,
			buildNotification(reminder, {
				kind: isNag ? 'nag' : 'snooze',
				occurrenceId: occurrence.id,
				scheduledAt: occurrence.scheduled_at,
				nagIndex: nagCount,
				now: ctx.now(),
			}),
			jobNonce(job.id),
		);
		if (outcome.type !== 'ok') {
			await handleSendFailure(ctx, job, outcome, null);
			return;
		}
		messageId = outcome.messageId;
		await recordJobSentMessage(ctx.db, job.id, messageId);
	}

	const now = ctx.now();
	await ctx.db.batch(
		compact([
			updateOccurrenceStatement(ctx.db, occurrence.id, { last_message_id: messageId, nag_count: nagCount }),
			nagStatement(ctx, reminder, occurrence, nagCount, owned(job)),
			updateJobStatement(ctx.db, job.id, { status: 'sent' }, now, owned(job)),
		]),
	);

	if (occurrence.last_message_id !== messageId) {
		await removeButtons(ctx.rest, channelId, occurrence.last_message_id);
	}
}

async function processJob(ctx: DispatchContext, job: ClaimedJob): Promise<void> {
	const reminder = await getReminder(ctx.db, job.reminder_id);
	if (!reminder) {
		await finishJob(ctx, job, 'cancelled');
		return;
	}
	switch (job.kind) {
		case 'pre':
			return processPreJob(ctx, job, reminder);
		case 'main':
			return processMainJob(ctx, job, reminder);
		case 'nag':
		case 'snooze':
			return processFollowUpJob(ctx, job, reminder);
	}
}

/** ジョブの処理中の想定外の例外を記録し、再試行に回すか諦める */
async function handleUnexpectedError(ctx: DispatchContext, job: ClaimedJob, error: unknown): Promise<void> {
	console.error(`Unexpected error while processing reminder job ${job.id}:`, error);
	try {
		// 失敗時の状態の確定 (giveUp) 自体が失敗した場合は、状態が確定していないため試行回数にかかわらず再試行する
		if (!(error instanceof StateTransitionError) && job.attempt_count + 1 >= MAX_ATTEMPTS) {
			// 本通知の処理中に作成した回も閉じられるよう、ジョブを読み直す
			const current = await getJob(ctx.db, job.id);
			await giveUp(ctx, job, {
				detail: String(error),
				disableReminder: false,
				occurrenceId: current?.occurrence_id ?? job.occurrence_id,
			});
			return;
		}
		await retryLater(ctx, job, RETRY_DELAY_MS, true);
	} catch (recordError) {
		// 状態の確定に失敗した場合は、再試行できる状態に戻す (ロールバック済みのため不整合は残らない)
		console.error('Failed to record job failure:', recordError);
		await retryLater(ctx, job, RETRY_DELAY_MS, true).catch((retryError) =>
			console.error('Failed to reschedule job:', retryError),
		);
	}
}

/** 自己修復の対象にする最終更新からの経過時間 (処理中の操作と競合しないよう十分に空ける) */
const REPAIR_MIN_AGE_MS = 10 * MINUTE_MS;
const REPAIR_BATCH_SIZE = 20;

/**
 * 有効なのに未送信の本通知ジョブがないリマインダ (途中で失敗した登録・編集などの取り残し) の予定を作り直す。
 * 読み取り後に変更された場合は何もしない (guard)。
 */
async function repairMissingSchedules(ctx: DispatchContext): Promise<void> {
	const now = ctx.now();
	for (const reminder of await findRemindersWithoutSchedule(ctx.db, now, REPAIR_MIN_AGE_MS, REPAIR_BATCH_SIZE)) {
		console.error(`[ALERT] Repairing reminder without a pending main job: reminderId=${reminder.id}`);
		// 1 回のみで通知時刻を過ぎていても、未送信のまま終わらせずにすぐ送る (遅延の注記付き)
		const afterMs = reminder.schedule_type === 'once' ? 0 : now;
		const { statements } = planUpcoming(ctx.db, reminder, afterMs, now, { guardRevision: reminder.revision });
		await ctx.db.batch(statements);
	}
}

/** 期限を迎えたジョブを処理する (Cron から毎分呼ばれる)。処理したジョブ数を返す */
export async function dispatchDueJobs(params: { db: ReminderDb; rest: Rest; now?: () => number }): Promise<number> {
	const ctx: DispatchContext = { db: params.db, rest: params.rest, now: params.now ?? Date.now };
	const startedAt = ctx.now();
	let processed = 0;

	while (ctx.now() - startedAt < EXECUTION_BUDGET_MS) {
		const jobs = await findDueJobs(ctx.db, ctx.now(), BATCH_SIZE);
		let claimedAny = false;
		for (const job of jobs) {
			if (ctx.now() - startedAt >= EXECUTION_BUDGET_MS) {
				break;
			}
			const claimedAt = ctx.now();
			if (!(await claimJob(ctx.db, job.id, claimedAt))) {
				continue;
			}
			const claimed: ClaimedJob = { ...job, status: 'processing', locked_at: claimedAt };
			claimedAny = true;
			processed++;
			try {
				await processJob(ctx, claimed);
			} catch (error) {
				await handleUnexpectedError(ctx, claimed, error);
			}
		}
		if (!claimedAny || jobs.length < BATCH_SIZE) {
			break;
		}
	}

	await repairMissingSchedules(ctx).catch((error) => console.error('Failed to repair reminder schedules:', error));

	// 1 時間に 1 回、古いデータを掃除する
	if (new Date(startedAt).getUTCMinutes() === 0) {
		await cleanupExpired(ctx.db, startedAt).catch((error) => console.error('Failed to clean up reminders:', error));
	}

	return processed;
}
