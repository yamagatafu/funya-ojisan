import type { DbStatement, ReminderDb } from '../types.ts';
import { MINUTE_MS } from './date.ts';
import {
	allConditions,
	cancelPendingJobsStatement,
	type ExtraCondition,
	getReminder,
	guardCondition,
	insertJobStatement,
	insertReminder,
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
export function cancelUpcomingStatement(db: ReminderDb, reminderId: number, now: number): DbStatement {
	return cancelPendingJobsStatement(db, { reminderId, kinds: ['pre', 'main'] }, now);
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
 * 条件に合う通知日時がない場合は登録せずにエラーを返す。
 */
export async function createReminder(db: ReminderDb, input: ReminderInput, now: number): Promise<CreateReminderResult> {
	const draft: ReminderRow = {
		...input,
		id: 0,
		status: 'active',
		last_error: null,
		next_run_at: null,
		created_at: now,
		updated_at: now,
	};
	if (!computeNextOccurrence(reminderToSchedule(draft), now)) {
		return { ok: false, message: '条件に合う通知日時がありません。日時・繰り返し・終了日を確認してください。' };
	}

	const id = await insertReminder(db, input, now);
	const reminder = await getReminder(db, id);
	if (!reminder) {
		throw new Error(`Reminder ${id} disappeared`);
	}
	const occurrence = await scheduleUpcoming(db, reminder, now, now);
	if (!occurrence) {
		throw new Error(`Reminder ${id} has no occurrence`);
	}
	return { ok: true, reminder: { ...reminder, next_run_at: occurrence.runAt }, occurrence };
}
