import type { DbStatement, ReminderDb } from '../types.ts';
import { MINUTE_MS } from './date.ts';
import { MAX_REMINDERS_PER_GUILD, MAX_REMINDERS_PER_USER } from './permissions.ts';
import {
	allConditions,
	cancelPendingJobsStatement,
	type ExtraCondition,
	getReminder,
	guardCondition,
	insertJobStatement,
	insertReminderWithFirstJobsStatements,
	type ReminderInput,
	type ReminderRow,
	type ReminderUpdate,
	updateReminderStatement,
} from './repository.ts';
import { computeNextOccurrence, type Occurrence, type Schedule } from './schedule.ts';

export function reminderToSchedule(reminder: ReminderRow): Schedule {
	return {
		type: reminder.schedule_type,
		timeOfDay: reminder.time_of_day,
		onceAt: reminder.once_at,
		weekdaysMask: reminder.weekdays_mask,
		dayOfMonth: reminder.day_of_month,
		nthWeek: reminder.nth_week,
		startDate: reminder.start_date,
		holidayPolicy: reminder.holiday_policy,
		endDate: reminder.end_date,
		remainingCount: reminder.remaining_count,
	};
}

export interface PlanOptions {
	/**
	 * 指定すると、リマインダが有効で revision がこの値と一致する場合だけ反映する
	 * (一時停止・編集など、読み取り後の変更と競合した場合は何もしない)
	 */
	guardRevision?: number;
	/** すべての文に追加する条件 (ジョブのロックの所有権など) */
	condition?: ExtraCondition;
	/** 次回の予定と同じ UPDATE 文で更新する項目 (残り回数など) */
	extraUpdate?: ReminderUpdate;
}

/**
 * afterMs より後の次回の本通知 (と事前通知) のジョブを登録し、next_run_at を更新する SQL 文を組み立てる。
 * 次回がなければリマインダを ended にする文を返す。
 * 他の更新と同じ batch (トランザクション) で実行できるよう、実行はしない。
 * ジョブの登録を先に、リマインダの更新 (revision が変わる) を最後に行う。
 */
export function planUpcoming(
	db: ReminderDb,
	reminder: ReminderRow,
	afterMs: number,
	now: number,
	options: PlanOptions = {},
): { occurrence: Occurrence | null; statements: DbStatement[] } {
	const condition = allConditions(
		options.guardRevision === undefined
			? undefined
			: guardCondition({ reminderId: reminder.id, revision: options.guardRevision }),
		options.condition,
	);
	const occurrence = computeNextOccurrence(reminderToSchedule(reminder), afterMs);
	if (!occurrence) {
		return {
			occurrence: null,
			statements: [
				updateReminderStatement(
					db,
					reminder.id,
					{ ...options.extraUpdate, status: 'ended', next_run_at: null },
					now,
					condition,
				)!,
			],
		};
	}

	const statements = [
		insertJobStatement(
			db,
			{
				reminderId: reminder.id,
				occurrenceId: null,
				kind: 'main',
				runAt: occurrence.runAt,
				scheduledAt: occurrence.runAt,
			},
			now,
			condition,
		),
	];

	if (reminder.pre_notify_minutes) {
		const preRunAt = occurrence.runAt - reminder.pre_notify_minutes * MINUTE_MS;
		if (preRunAt > now) {
			statements.push(
				insertJobStatement(
					db,
					{
						reminderId: reminder.id,
						occurrenceId: null,
						kind: 'pre',
						runAt: preRunAt,
						scheduledAt: occurrence.runAt,
					},
					now,
					condition,
				),
			);
		}
	}

	statements.push(
		updateReminderStatement(
			db,
			reminder.id,
			{ ...options.extraUpdate, next_run_at: occurrence.runAt },
			now,
			condition,
		)!,
	);
	return { occurrence, statements };
}

/**
 * afterMs より後の次回の本通知 (と事前通知) のジョブを登録し、next_run_at を更新する。
 * 次回がなければリマインダを ended にする。
 */
export async function scheduleUpcoming(
	db: ReminderDb,
	reminder: ReminderRow,
	afterMs: number,
	now: number,
	options: PlanOptions = {},
): Promise<Occurrence | null> {
	const { occurrence, statements } = planUpcoming(db, reminder, afterMs, now, options);
	await db.batch(statements);
	return occurrence;
}

/** 未送信の本通知・事前通知を取り消す SQL 文 (編集・一時停止・削除時) */
export function cancelUpcomingStatement(
	db: ReminderDb,
	reminderId: number,
	now: number,
	condition?: ExtraCondition,
): DbStatement {
	return cancelPendingJobsStatement(db, { reminderId, kinds: ['pre', 'main'] }, now, condition);
}

/** リマインダの revision が読み取り時の値のままであること (楽観的排他制御) */
export function unchangedSince(reminder: Pick<ReminderRow, 'id' | 'revision'>): ExtraCondition {
	return {
		sql: 'EXISTS (SELECT 1 FROM reminders WHERE id = ? AND revision = ?)',
		values: [reminder.id, reminder.revision],
	};
}

/** 直前の文がちょうど 1 行を変更した場合だけ満たされる条件 (batch 内で前の文が反映された場合だけ続ける) */
const PREVIOUS_APPLIED: ExtraCondition = { sql: 'changes() = 1', values: [] };

/**
 * 読み取り後に変更されていない場合だけ、予定の取り消し・内容の更新・次回予定の登録を 1 つの batch で行う
 * (楽観的排他制御)。更新が反映されたかを返す。
 * - 予定の取り消しと更新は、revision が読み取り時の値の場合だけ行う
 * - 次回の予定時刻 (または終了) は更新と同じ UPDATE 文で設定し、ジョブはその UPDATE が反映された場合だけ
 *   (changes() = 1 の連鎖で) 登録する
 */
export async function updateReminderAndSchedule(
	db: ReminderDb,
	reminder: ReminderRow,
	update: ReminderUpdate,
	params: { now: number; schedule: boolean; condition?: ExtraCondition },
): Promise<{ applied: boolean; occurrence: Occurrence | null }> {
	const { now } = params;
	const unchanged = unchangedSince(reminder);
	const occurrence = params.schedule
		? computeNextOccurrence(reminderToSchedule({ ...reminder, ...update }), now)
		: null;
	const fullUpdate: ReminderUpdate = params.schedule
		? occurrence
			? { ...update, next_run_at: occurrence.runAt }
			: { ...update, status: 'ended', next_run_at: null }
		: update;
	const updateStatement = updateReminderStatement(
		db,
		reminder.id,
		fullUpdate,
		now,
		allConditions(unchanged, params.condition),
	);
	if (!updateStatement) {
		throw new Error('Nothing to update');
	}

	const jobStatements: DbStatement[] = [];
	if (occurrence) {
		jobStatements.push(
			insertJobStatement(
				db,
				{
					reminderId: reminder.id,
					occurrenceId: null,
					kind: 'main',
					runAt: occurrence.runAt,
					scheduledAt: occurrence.runAt,
				},
				now,
				PREVIOUS_APPLIED,
			),
		);
		const preMinutes = { ...reminder, ...update }.pre_notify_minutes;
		if (preMinutes) {
			const preRunAt = occurrence.runAt - preMinutes * MINUTE_MS;
			if (preRunAt > now) {
				jobStatements.push(
					insertJobStatement(
						db,
						{
							reminderId: reminder.id,
							occurrenceId: null,
							kind: 'pre',
							runAt: preRunAt,
							scheduledAt: occurrence.runAt,
						},
						now,
						PREVIOUS_APPLIED,
					),
				);
			}
		}
	}

	const results = await db.batch([
		cancelUpcomingStatement(db, reminder.id, now, unchanged),
		updateStatement,
		...jobStatements,
	]);
	return { applied: (results[1]?.results.length ?? 0) > 0, occurrence };
}

/** 未送信の本通知・事前通知を取り消す (編集・一時停止・削除時) */
export async function cancelUpcoming(db: ReminderDb, reminderId: number, now: number): Promise<void> {
	await cancelUpcomingStatement(db, reminderId, now).run();
}

export type CreateReminderResult =
	| { ok: true; reminder: ReminderRow; occurrence: Occurrence }
	| { ok: false; message: string };

/**
 * リマインダを登録し、最初の通知ジョブを作る。
 * リマインダと最初のジョブは 1 つの batch (トランザクション) で登録するため、途中で失敗しても
 * ジョブのない有効なリマインダは残らない。件数の上限も同じ batch の中で確認する。
 * 条件に合う通知日時がない場合・上限に達している場合は登録せずにエラーを返す。
 */
export async function createReminder(db: ReminderDb, input: ReminderInput, now: number): Promise<CreateReminderResult> {
	const draft: ReminderRow = {
		...input,
		id: 0,
		status: 'active',
		last_error: null,
		next_run_at: null,
		revision: 0,
		created_at: now,
		updated_at: now,
	};
	const occurrence = computeNextOccurrence(reminderToSchedule(draft), now);
	if (!occurrence) {
		return { ok: false, message: '条件に合う通知日時がありません。日時・繰り返し・終了日を確認してください。' };
	}

	const preRunAt = input.pre_notify_minutes ? occurrence.runAt - input.pre_notify_minutes * MINUTE_MS : null;
	const [inserted] = await db.batch<{ id: number }>(
		insertReminderWithFirstJobsStatements(
			db,
			input,
			{ runAt: occurrence.runAt, preRunAt: preRunAt !== null && preRunAt > now ? preRunAt : null },
			{ perUser: MAX_REMINDERS_PER_USER, perGuild: MAX_REMINDERS_PER_GUILD },
			now,
		),
	);
	const id = inserted?.results[0]?.id;
	if (id === undefined) {
		return {
			ok: false,
			message: '登録できるリマインダの上限に達しています。不要なものを /remind delete で削除してください。',
		};
	}

	const reminder = await getReminder(db, id);
	if (!reminder) {
		throw new Error(`Reminder ${id} disappeared`);
	}
	return { ok: true, reminder, occurrence };
}
