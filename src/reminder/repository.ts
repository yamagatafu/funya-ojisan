import type { DbStatement, ReminderDb } from '../types.ts';
import type { HolidayPolicy, ScheduleType } from './schedule.ts';

export type MentionType = 'self' | 'user' | 'role' | 'none';
export type ReminderStatus = 'active' | 'paused' | 'ended' | 'error';
export type JobKind = 'pre' | 'main' | 'snooze' | 'nag';
export type JobStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
export type OccurrenceState = 'open' | 'completed' | 'superseded';

export interface ReminderRow {
	id: number;
	guild_id: string;
	channel_id: string;
	owner_id: string;
	content: string;
	source_message_url: string | null;
	mention_type: MentionType;
	mention_target_id: string | null;
	schedule_type: ScheduleType;
	time_of_day: number;
	once_at: number | null;
	weekdays_mask: number | null;
	day_of_month: number | null;
	nth_week: number | null;
	start_date: string | null;
	holiday_policy: HolidayPolicy;
	pre_notify_minutes: number | null;
	nag_interval_minutes: number | null;
	nag_max_count: number | null;
	end_date: string | null;
	remaining_count: number | null;
	status: ReminderStatus;
	last_error: string | null;
	next_run_at: number | null;
	/** 更新のたびに 1 ずつ増える (migrations/0004)。読み取り後の変更検知に使う */
	revision: number;
	created_at: number;
	updated_at: number;
}

/** 登録時に指定する項目 */
export type ReminderInput = Omit<
	ReminderRow,
	'id' | 'status' | 'last_error' | 'next_run_at' | 'revision' | 'created_at' | 'updated_at'
>;

export type ReminderUpdate = Partial<Omit<ReminderRow, 'id' | 'revision' | 'created_at' | 'updated_at'>>;

export interface OccurrenceRow {
	id: number;
	reminder_id: number;
	/** 通知を送信したチャンネル (migrations/0003 以前の行は null) */
	channel_id: string | null;
	scheduled_at: number;
	last_message_id: string | null;
	nag_count: number;
	state: OccurrenceState;
	completed_by: string | null;
	completed_at: number | null;
}

export interface JobRow {
	id: number;
	reminder_id: number;
	occurrence_id: number | null;
	kind: JobKind;
	run_at: number;
	scheduled_at: number;
	status: JobStatus;
	attempt_count: number;
	locked_at: number | null;
	/** 送信済みのメッセージ ID (送信後の処理が失敗した場合の再送防止) */
	sent_message_id: string | null;
	updated_at: number;
}

/** processing のまま放置されたジョブを再取得するまでの時間 */
export const STALE_LOCK_MS = 5 * 60 * 1000;
/** 終了したリマインダ・処理済みジョブを保持する期間 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const REMINDER_INPUT_COLUMNS = [
	'guild_id',
	'channel_id',
	'owner_id',
	'content',
	'source_message_url',
	'mention_type',
	'mention_target_id',
	'schedule_type',
	'time_of_day',
	'once_at',
	'weekdays_mask',
	'day_of_month',
	'nth_week',
	'start_date',
	'holiday_policy',
	'pre_notify_minutes',
	'nag_interval_minutes',
	'nag_max_count',
	'end_date',
	'remaining_count',
] as const satisfies readonly (keyof ReminderInput)[];

const REMINDER_UPDATABLE_COLUMNS = new Set<string>([...REMINDER_INPUT_COLUMNS, 'status', 'last_error', 'next_run_at']);

// ---- reminders ----

export async function insertReminder(db: ReminderDb, input: ReminderInput, now: number): Promise<number> {
	const columns = [...REMINDER_INPUT_COLUMNS, 'status', 'created_at', 'updated_at'];
	const values = [...REMINDER_INPUT_COLUMNS.map((column) => input[column]), 'active', now, now];
	const row = await db
		.prepare(
			`INSERT INTO reminders (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING id`,
		)
		.bind(...values)
		.first<{ id: number }>();
	if (!row) {
		throw new Error('Failed to insert reminder');
	}
	return row.id;
}

/** 件数の上限 (登録・復活時) を満たすことを表す条件。終了済み (ended) のリマインダは数えない */
export function withinLimitsCondition(
	params: { guildId: string; ownerId: string },
	limits: { perUser: number; perGuild: number },
): ExtraCondition {
	return {
		sql: "(SELECT COUNT(*) FROM reminders WHERE guild_id = ? AND owner_id = ? AND status != 'ended') < ? AND (SELECT COUNT(*) FROM reminders WHERE guild_id = ? AND status != 'ended') < ?",
		values: [params.guildId, params.ownerId, limits.perUser, params.guildId, limits.perGuild],
	};
}

/**
 * リマインダと最初の通知ジョブを 1 つの batch (トランザクション) で登録する SQL 文を組み立てる。
 * - リマインダは件数の上限を満たす場合だけ登録する (件数の確認と登録を 1 つの文で行う)
 * - ジョブは、直前の文が 1 行登録した場合 (changes() = 1) だけ、その行 (last_insert_rowid()) に紐づけて登録する。
 *   上限で登録されなかった場合はジョブも登録されない
 * 1 つ目の文の結果 (RETURNING id) が空なら、上限で登録されなかったことを表す。
 */
export function insertReminderWithFirstJobsStatements(
	db: ReminderDb,
	input: ReminderInput,
	first: { runAt: number; preRunAt: number | null },
	limits: { perUser: number; perGuild: number },
	now: number,
): DbStatement[] {
	const columns = [...REMINDER_INPUT_COLUMNS, 'status', 'next_run_at', 'created_at', 'updated_at'];
	const values = [...REMINDER_INPUT_COLUMNS.map((column) => input[column]), 'active', first.runAt, now, now];
	const limit = withinLimitsCondition({ guildId: input.guild_id, ownerId: input.owner_id }, limits);
	const statements = [
		db
			.prepare(
				`INSERT INTO reminders (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')} WHERE ${limit.sql} RETURNING id`,
			)
			.bind(...values, ...limit.values),
		db
			.prepare(
				"INSERT INTO reminder_jobs (reminder_id, occurrence_id, kind, run_at, scheduled_at, status, updated_at) SELECT last_insert_rowid(), NULL, 'main', ?, ?, 'pending', ? WHERE changes() = 1",
			)
			.bind(first.runAt, first.runAt, now),
	];
	if (first.preRunAt !== null) {
		statements.push(
			db
				.prepare(
					"INSERT INTO reminder_jobs (reminder_id, occurrence_id, kind, run_at, scheduled_at, status, updated_at) SELECT reminder_id, NULL, 'pre', ?, ?, 'pending', ? FROM reminder_jobs WHERE id = last_insert_rowid() AND changes() = 1",
				)
				.bind(first.preRunAt, first.runAt, now),
		);
	}
	return statements;
}

export function getReminder(db: ReminderDb, id: number): Promise<ReminderRow | null> {
	return db.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first<ReminderRow>();
}

/**
 * スケジュールの更新を、リマインダが有効で、読み取り時から変更されていない (revision が一致する) 場合に限定する条件。
 * 一時停止・編集などと競合した場合に、古い内容で予定を登録したり状態を上書きしたりしないために使う。
 */
export interface ScheduleGuard {
	reminderId: number;
	revision: number;
}

const GUARD_SQL = "EXISTS (SELECT 1 FROM reminders WHERE id = ? AND status = 'active' AND revision = ?)";

/** batch に渡す SQL 文の配列から null (実行不要な文) を取り除く */
export function compact(statements: (DbStatement | null)[]): DbStatement[] {
	return statements.filter((statement): statement is DbStatement => statement !== null);
}

/** UPDATE / INSERT に追加する WHERE 条件 */
export interface ExtraCondition {
	sql: string;
	values: unknown[];
}

export function guardCondition(guard: ScheduleGuard): ExtraCondition {
	return { sql: GUARD_SQL, values: [guard.reminderId, guard.revision] };
}

/** 複数の条件をすべて満たすことを表す条件 */
export function allConditions(...conditions: (ExtraCondition | undefined)[]): ExtraCondition | undefined {
	const present = conditions.filter((condition): condition is ExtraCondition => condition !== undefined);
	if (present.length === 0) {
		return undefined;
	}
	return {
		sql: present.map((condition) => `(${condition.sql})`).join(' AND '),
		values: present.flatMap((condition) => condition.values),
	};
}

/**
 * ジョブを確保した実行が、今もそのジョブのロックを持っていることを表す条件。
 * ロックが切れて別の実行に再取得された後に、古い実行が結果を書き込まないために使う
 * (再取得には 5 分以上の経過が必要なため、確保時刻の locked_at は実行ごとに異なる)。
 */
export function jobOwnershipCondition(jobId: number, lockedAt: number): ExtraCondition {
	return {
		sql: "EXISTS (SELECT 1 FROM reminder_jobs WHERE id = ? AND status = 'processing' AND locked_at = ?)",
		values: [jobId, lockedAt],
	};
}

export function updateReminderStatement(
	db: ReminderDb,
	id: number,
	update: ReminderUpdate,
	now: number,
	condition?: ExtraCondition,
): DbStatement | null {
	const entries = Object.entries(update).filter(
		([column, value]) => REMINDER_UPDATABLE_COLUMNS.has(column) && value !== undefined,
	);
	if (entries.length === 0) {
		return null;
	}
	const assignments = [...entries.map(([column]) => `${column} = ?`), 'revision = revision + 1', 'updated_at = ?'];
	const where = condition ? `id = ? AND ${condition.sql}` : 'id = ?';
	return db
		.prepare(`UPDATE reminders SET ${assignments.join(', ')} WHERE ${where} RETURNING id`)
		.bind(...entries.map(([, value]) => value), now, id, ...(condition?.values ?? []));
}

export async function updateReminder(db: ReminderDb, id: number, update: ReminderUpdate, now: number): Promise<void> {
	await updateReminderStatement(db, id, update, now)?.run();
}

export async function deleteReminder(db: ReminderDb, id: number): Promise<void> {
	await db.prepare('DELETE FROM reminders WHERE id = ?').bind(id).run();
}

export async function listReminders(
	db: ReminderDb,
	params: { guildId: string; ownerId?: string; includeEnded?: boolean; limit: number },
): Promise<ReminderRow[]> {
	const conditions = ['guild_id = ?'];
	const values: unknown[] = [params.guildId];
	if (params.ownerId) {
		conditions.push('owner_id = ?');
		values.push(params.ownerId);
	}
	if (!params.includeEnded) {
		conditions.push("status != 'ended'");
	}
	const { results } = await db
		.prepare(
			`SELECT * FROM reminders WHERE ${conditions.join(' AND ')} ORDER BY next_run_at IS NULL, next_run_at, id LIMIT ?`,
		)
		.bind(...values, params.limit)
		.all<ReminderRow>();
	return results;
}

/** 終了していないリマインダの件数 */
export async function countLiveReminders(
	db: ReminderDb,
	params: { guildId: string; ownerId?: string },
): Promise<number> {
	const row = params.ownerId
		? await db
				.prepare(
					"SELECT COUNT(*) AS count FROM reminders WHERE guild_id = ? AND owner_id = ? AND status != 'ended'",
				)
				.bind(params.guildId, params.ownerId)
				.first<{ count: number }>()
		: await db
				.prepare("SELECT COUNT(*) AS count FROM reminders WHERE guild_id = ? AND status != 'ended'")
				.bind(params.guildId)
				.first<{ count: number }>();
	return row?.count ?? 0;
}

// ---- occurrences ----

export async function insertOccurrence(
	db: ReminderDb,
	reminderId: number,
	scheduledAt: number,
	channelId: string,
): Promise<number> {
	const row = await db
		.prepare(
			"INSERT INTO reminder_occurrences (reminder_id, scheduled_at, state, channel_id) VALUES (?, ?, 'open', ?) RETURNING id",
		)
		.bind(reminderId, scheduledAt, channelId)
		.first<{ id: number }>();
	if (!row) {
		throw new Error('Failed to insert occurrence');
	}
	return row.id;
}

export function getOccurrence(db: ReminderDb, id: number): Promise<OccurrenceRow | null> {
	return db.prepare('SELECT * FROM reminder_occurrences WHERE id = ?').bind(id).first<OccurrenceRow>();
}

export async function deleteOccurrence(db: ReminderDb, id: number): Promise<void> {
	await db.prepare('DELETE FROM reminder_occurrences WHERE id = ?').bind(id).run();
}

export function updateOccurrenceStatement(
	db: ReminderDb,
	id: number,
	update: Partial<Omit<OccurrenceRow, 'id' | 'reminder_id' | 'scheduled_at'>>,
	condition?: ExtraCondition,
): DbStatement | null {
	const entries = Object.entries(update).filter(([, value]) => value !== undefined);
	if (entries.length === 0) {
		return null;
	}
	const where = condition ? `id = ? AND ${condition.sql}` : 'id = ?';
	return db
		.prepare(
			`UPDATE reminder_occurrences SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE ${where}`,
		)
		.bind(...entries.map(([, value]) => value), id, ...(condition?.values ?? []));
}

export async function updateOccurrence(
	db: ReminderDb,
	id: number,
	update: Partial<Omit<OccurrenceRow, 'id' | 'reminder_id' | 'scheduled_at'>>,
	condition?: ExtraCondition,
): Promise<void> {
	await updateOccurrenceStatement(db, id, update, condition)?.run();
}

/** open の状態を条件に完了・置き換えを行う SQL 文 */
export function closeOccurrenceStatement(
	db: ReminderDb,
	id: number,
	state: Exclude<OccurrenceState, 'open'>,
	params: { by?: string; now: number },
	condition?: ExtraCondition,
): DbStatement {
	const where = condition ? `id = ? AND state = 'open' AND ${condition.sql}` : "id = ? AND state = 'open'";
	return db
		.prepare(`UPDATE reminder_occurrences SET state = ?, completed_by = ?, completed_at = ? WHERE ${where}`)
		.bind(state, params.by ?? null, params.now, id, ...(condition?.values ?? []));
}

/** open の状態を条件に完了・置き換えを行う。他の処理と競合した場合は false */
export async function closeOccurrence(
	db: ReminderDb,
	id: number,
	state: Exclude<OccurrenceState, 'open'>,
	params: { by?: string; now: number },
): Promise<boolean> {
	const result = await closeOccurrenceStatement(db, id, state, params).run();
	return result.meta.changes === 1;
}

export async function listOpenOccurrences(db: ReminderDb, reminderId: number): Promise<OccurrenceRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM reminder_occurrences WHERE reminder_id = ? AND state = 'open' ORDER BY id")
		.bind(reminderId)
		.all<OccurrenceRow>();
	return results;
}

// ---- jobs ----

export interface NewJob {
	reminderId: number;
	occurrenceId: number | null;
	kind: JobKind;
	runAt: number;
	scheduledAt: number;
}

const INSERT_JOB_SQL =
	"INSERT INTO reminder_jobs (reminder_id, occurrence_id, kind, run_at, scheduled_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)";

/** condition を指定すると、その条件を満たす場合だけ登録する */
export function insertJobStatement(db: ReminderDb, job: NewJob, now: number, condition?: ExtraCondition): DbStatement {
	if (!condition) {
		return db
			.prepare(INSERT_JOB_SQL)
			.bind(job.reminderId, job.occurrenceId, job.kind, job.runAt, job.scheduledAt, now);
	}
	return db
		.prepare(
			`INSERT INTO reminder_jobs (reminder_id, occurrence_id, kind, run_at, scheduled_at, status, updated_at) SELECT ?, ?, ?, ?, ?, 'pending', ? WHERE ${condition.sql}`,
		)
		.bind(job.reminderId, job.occurrenceId, job.kind, job.runAt, job.scheduledAt, now, ...condition.values);
}

export async function insertJob(db: ReminderDb, job: NewJob, now: number): Promise<number> {
	const row = await db
		.prepare(`${INSERT_JOB_SQL} RETURNING id`)
		.bind(job.reminderId, job.occurrenceId, job.kind, job.runAt, job.scheduledAt, now)
		.first<{ id: number }>();
	if (!row) {
		throw new Error('Failed to insert job');
	}
	return row.id;
}

export function getJob(db: ReminderDb, id: number): Promise<JobRow | null> {
	return db.prepare('SELECT * FROM reminder_jobs WHERE id = ?').bind(id).first<JobRow>();
}

export async function listPendingJobs(db: ReminderDb, reminderId: number): Promise<JobRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM reminder_jobs WHERE reminder_id = ? AND status = 'pending' ORDER BY run_at, id")
		.bind(reminderId)
		.all<JobRow>();
	return results;
}

/** 未送信のジョブを取り消す SQL 文。kinds を省略するとすべての種類が対象 */
export function cancelPendingJobsStatement(
	db: ReminderDb,
	params: { reminderId: number; occurrenceId?: number; kinds?: JobKind[] },
	now: number,
	condition?: ExtraCondition,
): DbStatement {
	const conditions = ['reminder_id = ?', "status = 'pending'"];
	const values: unknown[] = [params.reminderId];
	if (condition) {
		conditions.push(condition.sql);
		values.push(...condition.values);
	}
	if (params.occurrenceId !== undefined) {
		conditions.push('occurrence_id = ?');
		values.push(params.occurrenceId);
	}
	if (params.kinds && params.kinds.length > 0) {
		conditions.push(`kind IN (${params.kinds.map(() => '?').join(', ')})`);
		values.push(...params.kinds);
	}
	return db
		.prepare(`UPDATE reminder_jobs SET status = 'cancelled', updated_at = ? WHERE ${conditions.join(' AND ')}`)
		.bind(now, ...values);
}

/** 未送信のジョブを取り消す。kinds を省略するとすべての種類が対象 */
export async function cancelPendingJobs(
	db: ReminderDb,
	params: { reminderId: number; occurrenceId?: number; kinds?: JobKind[] },
	now: number,
): Promise<void> {
	await cancelPendingJobsStatement(db, params, now).run();
}

export async function findDueJobs(db: ReminderDb, now: number, limit: number): Promise<JobRow[]> {
	const { results } = await db
		.prepare(
			"SELECT * FROM reminder_jobs WHERE (status = 'pending' AND run_at <= ?) OR (status = 'processing' AND locked_at < ?) ORDER BY run_at, id LIMIT ?",
		)
		.bind(now, now - STALE_LOCK_MS, limit)
		.all<JobRow>();
	return results;
}

/** ジョブを排他的に確保する。他の実行が確保済みなら false */
export async function claimJob(db: ReminderDb, id: number, now: number): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE reminder_jobs SET status = 'processing', locked_at = ?, updated_at = ? WHERE id = ? AND ((status = 'pending' AND run_at <= ?) OR (status = 'processing' AND locked_at < ?))",
		)
		.bind(now, now, id, now, now - STALE_LOCK_MS)
		.run();
	return result.meta.changes === 1;
}

export type JobUpdate = Partial<Pick<JobRow, 'status' | 'run_at' | 'attempt_count' | 'occurrence_id'>>;

/** ジョブを更新する SQL 文。ロックは解除する。condition を指定すると、その条件を満たす場合だけ更新する (更新したかは RETURNING id で分かる) */
export function updateJobStatement(
	db: ReminderDb,
	id: number,
	update: JobUpdate,
	now: number,
	condition?: ExtraCondition,
): DbStatement {
	const entries = Object.entries(update).filter(([, value]) => value !== undefined);
	const where = condition ? `id = ? AND ${condition.sql}` : 'id = ?';
	return db
		.prepare(
			`UPDATE reminder_jobs SET ${[...entries.map(([column]) => `${column} = ?`), 'locked_at = NULL', 'updated_at = ?'].join(', ')} WHERE ${where} RETURNING id`,
		)
		.bind(...entries.map(([, value]) => value), now, id, ...(condition?.values ?? []));
}

export async function updateJob(
	db: ReminderDb,
	id: number,
	update: JobUpdate,
	now: number,
	condition?: ExtraCondition,
): Promise<void> {
	await updateJobStatement(db, id, update, now, condition).run();
}

/** 送信済みのメッセージ ID を記録する (再試行時の二重送信防止。ロックは維持する)。condition を満たす場合だけ記録する */
export async function recordJobSentMessage(
	db: ReminderDb,
	id: number,
	messageId: string,
	condition?: ExtraCondition,
): Promise<void> {
	const where = condition ? `id = ? AND ${condition.sql}` : 'id = ?';
	await db
		.prepare(`UPDATE reminder_jobs SET sent_message_id = ? WHERE ${where}`)
		.bind(messageId, id, ...(condition?.values ?? []))
		.run();
}

// ---- maintenance ----

/**
 * 有効なのに未送信の本通知ジョブがないリマインダ (途中で失敗した処理の取り残し) を探す。
 * 処理中の操作と競合しないよう、最終更新から minAgeMs 以上経ったものだけを対象にする。
 */
export async function findRemindersWithoutSchedule(
	db: ReminderDb,
	now: number,
	minAgeMs: number,
	limit: number,
): Promise<ReminderRow[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM reminders r WHERE r.status = 'active' AND r.updated_at < ?
			AND NOT EXISTS (SELECT 1 FROM reminder_jobs j WHERE j.reminder_id = r.id AND j.kind = 'main' AND j.status IN ('pending', 'processing'))
			ORDER BY r.updated_at LIMIT ?`,
		)
		.bind(now - minAgeMs, limit)
		.all<ReminderRow>();
	return results;
}

/** 保持期間を過ぎた処理済みジョブ・終了した通知・終了したリマインダを削除する */
export async function cleanupExpired(db: ReminderDb, now: number): Promise<void> {
	const threshold = now - RETENTION_MS;
	await db.batch([
		db
			.prepare("DELETE FROM reminder_jobs WHERE status IN ('sent', 'failed', 'cancelled') AND updated_at < ?")
			.bind(threshold),
		db
			.prepare(
				"DELETE FROM reminder_occurrences WHERE state != 'open' AND COALESCE(completed_at, scheduled_at) < ?",
			)
			.bind(threshold),
		db.prepare("DELETE FROM reminders WHERE status = 'ended' AND updated_at < ?").bind(threshold),
	]);
}
