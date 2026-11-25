import type { RESTPostAPIChannelMessageJSONBody } from 'discord-api-types/v10';
import { $channels$_$messages, $channels$_$messages$_, type createRest } from 'discord-hono';
import type { DbStatement, ReminderDb } from '../types.ts';
import { MINUTE_MS } from './date.ts';
import { buildNotification, buildPreNotification, type MessagePayload } from './message.ts';
import {
	cancelPendingJobs,
	cancelPendingJobsStatement,
	claimJob,
	cleanupExpired,
	closeOccurrence,
	closeOccurrenceStatement,
	findDueJobs,
	getOccurrence,
	getReminder,
	insertJobStatement,
	insertOccurrence,
	type JobRow,
	listOpenOccurrences,
	type OccurrenceRow,
	type ReminderRow,
	recordJobSentMessage,
	updateJob,
	updateJobStatement,
	updateOccurrence,
	updateOccurrenceStatement,
	updateReminder,
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

export async function postMessage(rest: Rest, channelId: string, payload: MessagePayload): Promise<SendOutcome> {
	let response: Awaited<ReturnType<Rest>>;
	try {
		response = await rest(
			'POST',
			$channels$_$messages,
			[channelId],
			payload as unknown as RESTPostAPIChannelMessageJSONBody,
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

async function finishJob(ctx: DispatchContext, job: JobRow, status: 'sent' | 'cancelled'): Promise<void> {
	await updateJob(ctx.db, job.id, { status }, ctx.now());
}

async function handleSendFailure(
	ctx: DispatchContext,
	job: JobRow,
	reminder: ReminderRow,
	outcome: Exclude<SendOutcome, { type: 'ok' }>,
	occurrenceId: number | null,
): Promise<void> {
	const now = ctx.now();
	switch (outcome.type) {
		case 'rate_limited':
			await updateJob(ctx.db, job.id, { status: 'pending', run_at: now + outcome.retryAfterMs }, now);
			return;
		case 'transient': {
			const attempts = job.attempt_count + 1;
			if (attempts >= MAX_ATTEMPTS) {
				console.error(
					`[ALERT] Reminder job failed after ${attempts} attempts: jobId=${job.id}, reminderId=${reminder.id}, ${outcome.detail}`,
				);
				await updateJob(ctx.db, job.id, { status: 'failed', attempt_count: attempts }, now);
				return;
			}
			console.error(`Reminder job failed transiently (attempt ${attempts}): jobId=${job.id}, ${outcome.detail}`);
			await updateJob(
				ctx.db,
				job.id,
				{ status: 'pending', run_at: now + RETRY_DELAY_MS, attempt_count: attempts },
				now,
			);
			return;
		}
		case 'permanent':
			// チャンネル削除・権限不足など。リマインダを error にして以降の送信を止める
			console.error(`[ALERT] Reminder disabled due to send error: reminderId=${reminder.id}, ${outcome.detail}`);
			await updateJob(ctx.db, job.id, { status: 'failed', attempt_count: job.attempt_count + 1 }, now);
			await updateReminder(
				ctx.db,
				reminder.id,
				{ status: 'error', last_error: outcome.detail, next_run_at: null },
				now,
			);
			await cancelPendingJobs(ctx.db, { reminderId: reminder.id }, now);
			if (occurrenceId !== null) {
				await closeOccurrence(ctx.db, occurrenceId, 'superseded', { now });
			}
			return;
	}
}

async function processPreJob(ctx: DispatchContext, job: JobRow, reminder: ReminderRow): Promise<void> {
	if (reminder.status !== 'active' || ctx.now() >= job.scheduled_at) {
		// 一時停止中、または本通知の時刻を過ぎた事前通知は送らない
		await finishJob(ctx, job, 'cancelled');
		return;
	}
	const outcome = await postMessage(ctx.rest, reminder.channel_id, buildPreNotification(reminder, job.scheduled_at));
	if (outcome.type === 'ok') {
		await finishJob(ctx, job, 'sent');
	} else {
		await handleSendFailure(ctx, job, reminder, outcome, null);
	}
}

/** 再通知ジョブを登録する SQL 文 (上限に達していれば null) */
function nagStatement(
	ctx: DispatchContext,
	reminder: ReminderRow,
	occurrence: Pick<OccurrenceRow, 'id' | 'scheduled_at'>,
	nagCount: number,
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
	);
}

/** 前の回の通知を置き換え済みにし、再通知・スヌーズを止める SQL 文と、ボタンを外す対象のメッセージ */
async function planSupersede(
	ctx: DispatchContext,
	reminder: ReminderRow,
	keepId: number,
): Promise<{ statements: DbStatement[]; messageIds: (string | null)[] }> {
	const statements: DbStatement[] = [];
	const messageIds: (string | null)[] = [];
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
		messageIds.push(occurrence.last_message_id);
	}
	return { statements, messageIds };
}

function compact(statements: (DbStatement | null)[]): DbStatement[] {
	return statements.filter((statement): statement is DbStatement => statement !== null);
}

async function processMainJob(ctx: DispatchContext, job: JobRow, reminder: ReminderRow): Promise<void> {
	if (reminder.status !== 'active') {
		await finishJob(ctx, job, 'cancelled');
		return;
	}

	// 前回の実行が送信後に中断していた場合は、送信済みの通知を使い回す (二重送信の防止)
	let occurrence = job.occurrence_id !== null ? await getOccurrence(ctx.db, job.occurrence_id) : null;
	if (!occurrence) {
		const occurrenceId = await insertOccurrence(ctx.db, reminder.id, job.scheduled_at);
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
		const outcome = await postMessage(
			ctx.rest,
			reminder.channel_id,
			buildNotification(reminder, {
				kind: 'main',
				occurrenceId: occurrence.id,
				scheduledAt: job.scheduled_at,
				now: ctx.now(),
			}),
		);
		if (outcome.type !== 'ok') {
			await handleSendFailure(ctx, job, reminder, outcome, occurrence.id);
			return;
		}
		await updateOccurrence(ctx.db, occurrence.id, { last_message_id: outcome.messageId });
	}

	// 送信後の処理は 1 つの batch (トランザクション) で行う。
	// 途中で失敗しても何も反映されないため、再試行で重複登録や残り回数の二重減算が起きない
	const now = ctx.now();
	const remainingCount = reminder.remaining_count === null ? null : Math.max(0, reminder.remaining_count - 1);
	const supersede = await planSupersede(ctx, reminder, occurrence.id);
	const upcoming = planUpcoming(
		ctx.db,
		{ ...reminder, remaining_count: remainingCount },
		Math.max(job.scheduled_at, now),
		now,
	);
	await ctx.db.batch(
		compact([
			...supersede.statements,
			nagStatement(ctx, reminder, occurrence, occurrence.nag_count),
			remainingCount === null
				? null
				: updateReminderStatement(ctx.db, reminder.id, { remaining_count: remainingCount }, now),
			...upcoming.statements,
			updateJobStatement(ctx.db, job.id, { status: 'sent' }, now),
		]),
	);

	for (const messageId of supersede.messageIds) {
		await removeButtons(ctx.rest, reminder.channel_id, messageId);
	}
}

async function processFollowUpJob(ctx: DispatchContext, job: JobRow, reminder: ReminderRow): Promise<void> {
	const occurrence = job.occurrence_id !== null ? await getOccurrence(ctx.db, job.occurrence_id) : null;
	if (occurrence?.state !== 'open') {
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
	let messageId = job.sent_message_id;
	if (!messageId) {
		const outcome = await postMessage(
			ctx.rest,
			reminder.channel_id,
			buildNotification(reminder, {
				kind: isNag ? 'nag' : 'snooze',
				occurrenceId: occurrence.id,
				scheduledAt: occurrence.scheduled_at,
				nagIndex: nagCount,
				now: ctx.now(),
			}),
		);
		if (outcome.type !== 'ok') {
			await handleSendFailure(ctx, job, reminder, outcome, null);
			return;
		}
		messageId = outcome.messageId;
		await recordJobSentMessage(ctx.db, job.id, messageId);
	}

	const now = ctx.now();
	await ctx.db.batch(
		compact([
			updateOccurrenceStatement(ctx.db, occurrence.id, { last_message_id: messageId, nag_count: nagCount }),
			nagStatement(ctx, reminder, occurrence, nagCount),
			updateJobStatement(ctx.db, job.id, { status: 'sent' }, now),
		]),
	);

	if (occurrence.last_message_id !== messageId) {
		await removeButtons(ctx.rest, reminder.channel_id, occurrence.last_message_id);
	}
}

async function processJob(ctx: DispatchContext, job: JobRow): Promise<void> {
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
			if (!(await claimJob(ctx.db, job.id, ctx.now()))) {
				continue;
			}
			claimedAny = true;
			processed++;
			try {
				await processJob(ctx, job);
			} catch (error) {
				console.error(`Unexpected error while processing reminder job ${job.id}:`, error);
				const attempts = job.attempt_count + 1;
				await updateJob(
					ctx.db,
					job.id,
					attempts >= MAX_ATTEMPTS
						? { status: 'failed', attempt_count: attempts }
						: { status: 'pending', run_at: ctx.now() + RETRY_DELAY_MS, attempt_count: attempts },
					ctx.now(),
				).catch((updateError) => console.error('Failed to record job failure:', updateError));
			}
		}
		if (!claimedAny || jobs.length < BATCH_SIZE) {
			break;
		}
	}

	// 1 時間に 1 回、古いデータを掃除する
	if (new Date(startedAt).getUTCMinutes() === 0) {
		await cleanupExpired(ctx.db, startedAt).catch((error) => console.error('Failed to clean up reminders:', error));
	}

	return processed;
}
