import type { ReminderDb } from '../types.ts';
import { MINUTE_MS } from './date.ts';
import { cancelPendingJobs, insertJob, type ReminderRow, updateReminder } from './repository.ts';
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

/**
 * afterMs より後の次回の本通知 (と事前通知) のジョブを登録し、next_run_at を更新する。
 * 次回がなければリマインダを ended にする。
 */
export async function scheduleUpcoming(
	db: ReminderDb,
	reminder: ReminderRow,
	afterMs: number,
	now: number,
): Promise<Occurrence | null> {
	const occurrence = computeNextOccurrence(reminderToSchedule(reminder), afterMs);
	if (!occurrence) {
		await updateReminder(db, reminder.id, { status: 'ended', next_run_at: null }, now);
		return null;
	}

	await insertJob(
		db,
		{
			reminderId: reminder.id,
			occurrenceId: null,
			kind: 'main',
			runAt: occurrence.runAt,
			scheduledAt: occurrence.runAt,
		},
		now,
	);

	if (reminder.pre_notify_minutes) {
		const preRunAt = occurrence.runAt - reminder.pre_notify_minutes * MINUTE_MS;
		if (preRunAt > now) {
			await insertJob(
				db,
				{
					reminderId: reminder.id,
					occurrenceId: null,
					kind: 'pre',
					runAt: preRunAt,
					scheduledAt: occurrence.runAt,
				},
				now,
			);
		}
	}

	await updateReminder(db, reminder.id, { next_run_at: occurrence.runAt }, now);
	return occurrence;
}

/** 未送信の本通知・事前通知を取り消す (編集・一時停止・削除時) */
export async function cancelUpcoming(db: ReminderDb, reminderId: number, now: number): Promise<void> {
	await cancelPendingJobs(db, { reminderId, kinds: ['pre', 'main'] }, now);
}
