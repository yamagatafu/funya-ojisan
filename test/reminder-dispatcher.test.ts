import { createRest } from 'discord-hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jstToUtcMs, MINUTE_MS } from '../src/reminder/date.ts';
import { dispatchDueJobs } from '../src/reminder/dispatcher.ts';
import {
	claimJob,
	getReminder,
	insertJob,
	insertReminder,
	type JobRow,
	type OccurrenceRow,
	type ReminderInput,
} from '../src/reminder/repository.ts';
import { scheduleUpcoming } from '../src/reminder/service.ts';
import type { DbStatement } from '../src/types.ts';
import { createTestDb } from './helpers/d1.ts';

const CHANNEL_ID = '200000000000000000';
const OWNER_ID = '300000000000000000';
const API = 'https://discord.com/api/v10';

function reminderInput(overrides: Partial<ReminderInput> = {}): ReminderInput {
	return {
		guild_id: '100000000000000000',
		channel_id: CHANNEL_ID,
		owner_id: OWNER_ID,
		content: 'ゴミ出し',
		source_message_url: null,
		mention_type: 'self',
		mention_target_id: null,
		schedule_type: 'daily',
		time_of_day: 9 * 60,
		once_at: null,
		weekdays_mask: null,
		day_of_month: null,
		nth_week: null,
		start_date: null,
		holiday_policy: 'notify',
		pre_notify_minutes: null,
		nag_interval_minutes: null,
		nag_max_count: null,
		end_date: null,
		remaining_count: null,
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function setup(overrides: Partial<ReminderInput> = {}, now = jstToUtcMs('2026-11-25', 8 * 60)) {
	const db = createTestDb();
	const id = await insertReminder(db, reminderInput(overrides), now);
	const reminder = (await getReminder(db, id))!;
	await scheduleUpcoming(db, reminder, now, now);
	return { db, id };
}

function jobs(db: ReturnType<typeof createTestDb>): JobRow[] {
	return db.raw.prepare('SELECT * FROM reminder_jobs ORDER BY id').all() as JobRow[];
}

function occurrences(db: ReturnType<typeof createTestDb>): OccurrenceRow[] {
	return db.raw.prepare('SELECT * FROM reminder_occurrences ORDER BY id').all() as OccurrenceRow[];
}

function mockDiscord() {
	let messageSeq = 0;
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
		if (init?.method === 'POST') {
			messageSeq++;
			return jsonResponse({ id: `msg-${messageSeq}` });
		}
		return jsonResponse({});
	});
}

function calls(fetchMock: ReturnType<typeof mockDiscord>) {
	return fetchMock.mock.calls.map(([url, init]) => ({
		method: init?.method,
		url: String(url),
		body: init?.body ? JSON.parse(String(init.body)) : undefined,
	}));
}

/** 条件に一致する SQL 文だけを実行時に失敗させる (batch の途中での失敗を再現する) */
function failStatements(
	db: ReturnType<typeof createTestDb>,
	predicate: (query: string, values: unknown[]) => boolean,
	times = 1,
) {
	const originalPrepare = db.prepare.bind(db);
	let remaining = times;
	const wrap = (query: string, statement: DbStatement, values: unknown[]): DbStatement => {
		const shouldFail = () => remaining > 0 && predicate(query, values) && remaining-- > 0;
		const failing = <T>(run: () => T): T => {
			if (shouldFail()) {
				throw new Error('D1 statement failed');
			}
			return run();
		};
		const raw = statement as DbStatement & { execute(): unknown };
		return {
			bind: (...next: unknown[]) => wrap(query, statement.bind(...next), next),
			first: (() => failing(() => statement.first())) as DbStatement['first'],
			all: (() => failing(() => statement.all())) as DbStatement['all'],
			run: () => failing(() => statement.run()),
			execute: () => failing(() => raw.execute()),
		} as DbStatement;
	};
	return vi.spyOn(db, 'prepare').mockImplementation((query: string) => wrap(query, originalPrepare(query), []));
}

const rest = createRest('test-token');

describe('dispatchDueJobs', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends a main notification with buttons and schedules the next occurrence', async () => {
		const { db, id } = await setup({ remaining_count: 3 });
		const fetchMock = mockDiscord();

		const now = jstToUtcMs('2026-11-25', 9 * 60);
		expect(await dispatchDueJobs({ db, rest, now: () => now })).toBe(1);

		const [post] = calls(fetchMock);
		expect(post?.url).toBe(`${API}/channels/${CHANNEL_ID}/messages`);
		expect(post?.body.content).toContain(`⏰ <@${OWNER_ID}> リマインド`);
		expect(post?.body.content).toContain('ゴミ出し');
		expect(post?.body.content).toContain(`-# #${id} · <@${OWNER_ID}> · 毎日 09:00（残り3回）`);
		expect(post?.body.allowed_mentions).toEqual({ parse: [], users: [OWNER_ID] });
		expect(post?.body.components[0].components.map((c: { custom_id: string }) => c.custom_id)).toEqual([
			'remind_done;1',
			'remind_snooze;1:5',
			'remind_snooze;1:15',
			'remind_snooze;1:30',
			'remind_snooze_custom;1',
		]);

		const reminder = await getReminder(db, id);
		expect(reminder?.remaining_count).toBe(2);
		expect(reminder?.next_run_at).toBe(jstToUtcMs('2026-11-26', 9 * 60));
		expect(jobs(db).map((job) => [job.kind, job.status])).toEqual([
			['main', 'sent'],
			['main', 'pending'],
		]);
		expect(occurrences(db)).toMatchObject([{ state: 'open', last_message_id: 'msg-1' }]);
	});

	it('ends a once reminder after sending', async () => {
		const { db, id } = await setup({ schedule_type: 'once', once_at: jstToUtcMs('2026-11-25', 9 * 60) });
		mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 9 * 60) });

		const reminder = await getReminder(db, id);
		expect(reminder?.status).toBe('ended');
		expect(reminder?.next_run_at).toBeNull();
	});

	it('does nothing before the scheduled time', async () => {
		const { db } = await setup();
		const fetchMock = mockDiscord();

		expect(await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 8 * 60 + 59) })).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('marks late main notifications', async () => {
		const { db } = await setup();
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 9 * 60 + 30) });

		expect(calls(fetchMock)[0]?.body.content).toContain('リマインド（予定 09:00 から遅延）');
		// 次回は現在時刻を基準に計算する
		expect(jobs(db).find((job) => job.status === 'pending')?.run_at).toBe(jstToUtcMs('2026-11-26', 9 * 60));
	});

	it('sends a pre-notification and skips it when it is already too late', async () => {
		const { db } = await setup({ pre_notify_minutes: 10 });
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 8 * 60 + 50) });
		expect(calls(fetchMock)[0]?.body.content).toContain(
			'⏳ <@300000000000000000> 10分後（09:00）にリマインドがあります',
		);
		expect(calls(fetchMock)[0]?.body.components).toBeUndefined();

		const late = await setup({ pre_notify_minutes: 10 });
		fetchMock.mockClear();
		await dispatchDueJobs({ db: late.db, rest, now: () => jstToUtcMs('2026-11-25', 9 * 60 + 5) });
		// 事前通知は取り消し、本通知だけ送る
		expect(calls(fetchMock).filter((call) => call.method === 'POST')).toHaveLength(1);
		expect(
			jobs(late.db)
				.filter((job) => job.kind === 'pre')
				.map((job) => job.status),
		).toContain('cancelled');
	});

	it('claims a job only once', async () => {
		const { db } = await setup();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		const [job] = jobs(db);
		expect(await claimJob(db, job!.id, now)).toBe(true);
		expect(await claimJob(db, job!.id, now)).toBe(false);
		// 放置されたロックは 5 分後に再取得できる
		expect(await claimJob(db, job!.id, now + 5 * MINUTE_MS + 1)).toBe(true);
	});

	it('reschedules on rate limit and retries transient errors', async () => {
		const { db } = await setup();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ retry_after: 3 }, 429));

		await dispatchDueJobs({ db, rest, now: () => now });
		expect(jobs(db)[0]).toMatchObject({ status: 'pending', run_at: now + 3000, attempt_count: 0 });

		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('oops', { status: 502 }));
		await dispatchDueJobs({ db, rest, now: () => now + 3000 });
		expect(jobs(db)[0]).toMatchObject({ status: 'pending', run_at: now + 3000 + MINUTE_MS, attempt_count: 1 });
	});

	it('disables the reminder on permanent errors', async () => {
		const { db, id } = await setup({ pre_notify_minutes: 10 });
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"message":"Missing Access"}', { status: 403 }));

		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 8 * 60 + 50) });

		const reminder = await getReminder(db, id);
		expect(reminder?.status).toBe('error');
		expect(reminder?.last_error).toContain('status=403');
		expect(jobs(db).map((job) => job.status)).toEqual(['cancelled', 'failed']);
	});

	it('nags until the max count, removing buttons from the previous message', async () => {
		const { db } = await setup({ nag_interval_minutes: 10, nag_max_count: 2 });
		const fetchMock = mockDiscord();
		const start = jstToUtcMs('2026-11-25', 9 * 60);

		await dispatchDueJobs({ db, rest, now: () => start });
		await dispatchDueJobs({ db, rest, now: () => start + 10 * MINUTE_MS });
		await dispatchDueJobs({ db, rest, now: () => start + 20 * MINUTE_MS });
		await dispatchDueJobs({ db, rest, now: () => start + 30 * MINUTE_MS });

		const sent = calls(fetchMock);
		expect(sent.map((call) => call.method)).toEqual(['POST', 'POST', 'PATCH', 'POST', 'PATCH']);
		expect(sent[1]?.body.content).toContain('🔁 <@300000000000000000> 再通知 (1/2)');
		expect(sent[2]).toMatchObject({
			url: `${API}/channels/${CHANNEL_ID}/messages/msg-1`,
			body: { components: [] },
		});
		expect(sent[3]?.body.content).toContain('再通知 (2/2)');
		expect(occurrences(db)).toMatchObject([{ state: 'open', nag_count: 2, last_message_id: 'msg-3' }]);
		expect(jobs(db).filter((job) => job.kind === 'nag' && job.status === 'pending')).toHaveLength(0);
	});

	it('supersedes the previous open occurrence when the next one is sent', async () => {
		const { db } = await setup({ nag_interval_minutes: 1440 * 2, nag_max_count: 3 });
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 9 * 60) });
		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-26', 9 * 60) });

		expect(occurrences(db).map((occurrence) => occurrence.state)).toEqual(['superseded', 'open']);
		expect(calls(fetchMock).find((call) => call.method === 'PATCH')?.url).toBe(
			`${API}/channels/${CHANNEL_ID}/messages/msg-1`,
		);
		const nagJobs = jobs(db).filter((job) => job.kind === 'nag');
		expect(nagJobs.map((job) => [job.occurrence_id, job.status])).toEqual([
			[1, 'cancelled'],
			[2, 'pending'],
		]);
	});

	it('does not resend when a previous run stopped after sending', async () => {
		const { db } = await setup();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		const [job] = jobs(db);
		db.raw.exec(
			`INSERT INTO reminder_occurrences (reminder_id, scheduled_at, state, last_message_id) VALUES (${job!.reminder_id}, ${job!.scheduled_at}, 'open', 'msg-x')`,
		);
		db.raw.exec(
			`UPDATE reminder_jobs SET status = 'processing', locked_at = ${now - 6 * MINUTE_MS}, occurrence_id = 1 WHERE id = ${job!.id}`,
		);
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => now });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(jobs(db).map((row) => [row.kind, row.status])).toEqual([
			['main', 'sent'],
			['main', 'pending'],
		]);
	});

	it('does not duplicate jobs or decrement twice when post-send processing fails and is retried', async () => {
		const { db, id } = await setup({ remaining_count: 3, nag_interval_minutes: 30, nag_max_count: 2 });
		const fetchMock = mockDiscord();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		const batch = db.batch.bind(db);
		const batchSpy = vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 unavailable'));

		await dispatchDueJobs({ db, rest, now: () => now });
		// 送信済みだが後処理は反映されていない
		expect(jobs(db).map((job) => [job.kind, job.status])).toEqual([['main', 'pending']]);
		expect((await getReminder(db, id))?.remaining_count).toBe(3);

		batchSpy.mockImplementation(batch);
		await dispatchDueJobs({ db, rest, now: () => now + MINUTE_MS });

		expect(calls(fetchMock).filter((call) => call.method === 'POST')).toHaveLength(1);
		expect((await getReminder(db, id))?.remaining_count).toBe(2);
		expect(jobs(db).map((job) => [job.kind, job.status])).toEqual([
			['main', 'sent'],
			['nag', 'pending'],
			['main', 'pending'],
		]);
	});

	it('does not resend a nag when post-send processing fails and is retried', async () => {
		const { db } = await setup({ nag_interval_minutes: 10, nag_max_count: 2 });
		const fetchMock = mockDiscord();
		const start = jstToUtcMs('2026-11-25', 9 * 60);
		await dispatchDueJobs({ db, rest, now: () => start });

		const batch = db.batch.bind(db);
		const batchSpy = vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 unavailable'));
		await dispatchDueJobs({ db, rest, now: () => start + 10 * MINUTE_MS });
		batchSpy.mockImplementation(batch);
		await dispatchDueJobs({ db, rest, now: () => start + 11 * MINUTE_MS });

		const posts = calls(fetchMock).filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(2);
		expect(posts[1]?.body.content).toContain('再通知 (1/2)');
		expect(occurrences(db)).toMatchObject([{ nag_count: 1, last_message_id: 'msg-2' }]);
		expect(
			jobs(db)
				.filter((job) => job.kind === 'nag')
				.map((job) => job.status),
		).toEqual(['sent', 'pending']);
	});

	it('does not send nags beyond the max count', async () => {
		const { db, id } = await setup({ nag_interval_minutes: 10, nag_max_count: 1 });
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		db.raw.exec(
			`INSERT INTO reminder_occurrences (reminder_id, scheduled_at, state, last_message_id, nag_count) VALUES (${id}, ${now}, 'open', 'msg-x', 1)`,
		);
		db.raw.exec("UPDATE reminder_jobs SET status = 'cancelled' WHERE kind = 'main'");
		await insertJob(db, { reminderId: id, occurrenceId: 1, kind: 'nag', runAt: now, scheduledAt: now }, now);
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => now });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(jobs(db).find((job) => job.kind === 'nag')?.status).toBe('cancelled');
	});

	it('rolls back the whole post-send batch when a later statement fails', async () => {
		const { db, id } = await setup({ remaining_count: 3, nag_interval_minutes: 30, nag_max_count: 2 });
		const fetchMock = mockDiscord();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		// 次回ジョブの登録・残り回数の更新などを実行した後、最後のジョブ完了の更新で失敗させる
		const spy = failStatements(
			db,
			(query, values) => query.startsWith('UPDATE reminder_jobs SET status') && values[0] === 'sent',
		);

		await dispatchDueJobs({ db, rest, now: () => now });
		spy.mockRestore();

		expect((await getReminder(db, id))?.remaining_count).toBe(3);
		expect(jobs(db).map((job) => [job.kind, job.status, job.attempt_count])).toEqual([['main', 'pending', 1]]);

		await dispatchDueJobs({ db, rest, now: () => now + MINUTE_MS });

		expect(calls(fetchMock).filter((call) => call.method === 'POST')).toHaveLength(1);
		expect((await getReminder(db, id))?.remaining_count).toBe(2);
		expect(jobs(db).map((job) => [job.kind, job.status])).toEqual([
			['main', 'sent'],
			['nag', 'pending'],
			['main', 'pending'],
		]);
	});

	it('sends with a per-job nonce so that Discord deduplicates a resend after a crash', async () => {
		const { db } = await setup({ nag_interval_minutes: 10, nag_max_count: 1 });
		const fetchMock = mockDiscord();
		const start = jstToUtcMs('2026-11-25', 9 * 60);
		await dispatchDueJobs({ db, rest, now: () => start });

		// 再通知の送信後、メッセージ ID の記録に失敗した状況を再現する
		const spy = failStatements(db, (query) => query.startsWith('UPDATE reminder_jobs SET sent_message_id'));
		await dispatchDueJobs({ db, rest, now: () => start + 10 * MINUTE_MS });
		spy.mockRestore();
		await dispatchDueJobs({ db, rest, now: () => start + 11 * MINUTE_MS });

		const posts = calls(fetchMock).filter((call) => call.method === 'POST');
		expect(posts.map((call) => [call.body.nonce, call.body.enforce_nonce])).toEqual([
			['reminder-job-1', true],
			['reminder-job-2', true],
			['reminder-job-2', true],
		]);
	});

	it('keeps the job retryable when recording a permanent error fails', async () => {
		const { db, id } = await setup();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"message":"Missing Access"}', { status: 403 }));
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		const spy = failStatements(db, (query) => query.startsWith('UPDATE reminders SET status'));

		await dispatchDueJobs({ db, rest, now: () => now });
		spy.mockRestore();

		expect((await getReminder(db, id))?.status).toBe('active');
		expect(jobs(db)).toMatchObject([{ kind: 'main', status: 'pending', attempt_count: 1 }]);

		await dispatchDueJobs({ db, rest, now: () => now + MINUTE_MS });
		expect((await getReminder(db, id))?.status).toBe('error');
		expect(jobs(db)).toMatchObject([{ kind: 'main', status: 'failed' }]);
	});

	it('disables the reminder when giving up on a main notification after transient errors', async () => {
		const { db, id } = await setup();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('oops', { status: 502 }));
		let now = jstToUtcMs('2026-11-25', 9 * 60);
		for (let i = 0; i < 5; i++) {
			await dispatchDueJobs({ db, rest, now: () => now });
			now += MINUTE_MS;
		}

		const reminder = await getReminder(db, id);
		expect(reminder?.status).toBe('error');
		expect(reminder?.last_error).toContain('status=502');
		expect(jobs(db)).toMatchObject([{ kind: 'main', status: 'failed', attempt_count: 5 }]);
	});

	it('does not send follow-ups for a reminder in error state', async () => {
		const { db, id } = await setup();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		db.raw.exec(
			`INSERT INTO reminder_occurrences (reminder_id, scheduled_at, state, last_message_id) VALUES (${id}, ${now}, 'open', 'msg-x')`,
		);
		db.raw.exec(`UPDATE reminders SET status = 'error' WHERE id = ${id}`);
		db.raw.exec("UPDATE reminder_jobs SET status = 'cancelled' WHERE kind = 'main'");
		await insertJob(db, { reminderId: id, occurrenceId: 1, kind: 'nag', runAt: now, scheduledAt: now }, now);
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => now });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(jobs(db).find((job) => job.kind === 'nag')?.status).toBe('cancelled');
	});

	it('does not overwrite a reminder that was edited while its notification was being sent', async () => {
		const sentAt = jstToUtcMs('2026-11-25', 9 * 60);
		const editedOnceAt = jstToUtcMs('2026-11-26', 18 * 60);
		const { db, id } = await setup({ schedule_type: 'once', once_at: sentAt });
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
			if (init?.method === 'POST') {
				// 送信中に /remind edit で日時が変更された状況を再現する
				db.raw.exec(
					`UPDATE reminders SET once_at = ${editedOnceAt}, next_run_at = ${editedOnceAt}, revision = revision + 1 WHERE id = ${id}`,
				);
				await insertJob(
					db,
					{
						reminderId: id,
						occurrenceId: null,
						kind: 'main',
						runAt: editedOnceAt,
						scheduledAt: editedOnceAt,
					},
					sentAt,
				);
				return jsonResponse({ id: 'msg-1' });
			}
			return jsonResponse({});
		});

		await dispatchDueJobs({ db, rest, now: () => sentAt });

		const reminder = await getReminder(db, id);
		expect(reminder).toMatchObject({ status: 'active', next_run_at: editedOnceAt });
		expect(jobs(db).map((job) => [job.status, job.run_at])).toEqual([
			['sent', sentAt],
			['pending', editedOnceAt],
		]);
	});

	it('does not schedule when the guard no longer matches', async () => {
		const { db, id } = await setup();
		db.raw.exec("UPDATE reminder_jobs SET status = 'cancelled'");
		const reminder = (await getReminder(db, id))!;
		const now = jstToUtcMs('2026-11-25', 8 * 60);

		await scheduleUpcoming(db, reminder, now, now, { guardRevision: reminder.revision + 1 });
		expect(jobs(db).filter((job) => job.status === 'pending')).toHaveLength(0);

		await scheduleUpcoming(db, reminder, now, now, { guardRevision: reminder.revision });
		expect(jobs(db).filter((job) => job.status === 'pending')).toHaveLength(1);
	});

	it('repairs an active reminder left without a pending main job', async () => {
		const createdAt = jstToUtcMs('2026-11-25', 8 * 60);
		const stale = await setup({}, createdAt);
		const fresh = await setup({}, createdAt);
		for (const { db } of [stale, fresh]) {
			db.raw.exec('DELETE FROM reminder_jobs');
		}
		mockDiscord();

		await dispatchDueJobs({ db: stale.db, rest, now: () => createdAt + 11 * MINUTE_MS });
		await dispatchDueJobs({ db: fresh.db, rest, now: () => createdAt + 9 * MINUTE_MS });

		expect(jobs(stale.db).map((job) => [job.kind, job.status, job.run_at])).toEqual([
			['main', 'pending', jstToUtcMs('2026-11-25', 9 * 60)],
		]);
		// 最終更新から間もないものは、処理中の操作と競合しないよう対象外
		expect(jobs(fresh.db)).toHaveLength(0);
	});

	it('sends follow-ups and removes buttons in the channel where the occurrence was sent', async () => {
		const { db, id } = await setup({ nag_interval_minutes: 10, nag_max_count: 1 });
		const fetchMock = mockDiscord();
		const start = jstToUtcMs('2026-11-25', 9 * 60);
		await dispatchDueJobs({ db, rest, now: () => start });
		db.raw.exec(`UPDATE reminders SET channel_id = '299999999999999999' WHERE id = ${id}`);

		await dispatchDueJobs({ db, rest, now: () => start + 10 * MINUTE_MS });

		expect(calls(fetchMock).map((call) => [call.method, call.url])).toEqual([
			['POST', `${API}/channels/${CHANNEL_ID}/messages`],
			['POST', `${API}/channels/${CHANNEL_ID}/messages`],
			['PATCH', `${API}/channels/${CHANNEL_ID}/messages/msg-1`],
		]);
		expect(occurrences(db)).toMatchObject([{ channel_id: CHANNEL_ID }]);
	});

	it('does not write results after the lock was taken over by another run', async () => {
		const { db } = await setup({ nag_interval_minutes: 10, nag_max_count: 1 });
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
			if (init?.method === 'POST') {
				// 送信中にロックが切れ、別の実行がジョブを再取得した状況を再現する
				db.raw.exec(`UPDATE reminder_jobs SET locked_at = ${now + 6 * MINUTE_MS} WHERE id = 1`);
				return jsonResponse({ id: 'msg-1' });
			}
			return jsonResponse({});
		});

		await dispatchDueJobs({ db, rest, now: () => now });

		// 古い実行は次回ジョブも再通知も登録せず、ジョブも完了にしない
		expect(jobs(db).map((job) => [job.kind, job.status, job.locked_at])).toEqual([
			['main', 'processing', now + 6 * MINUTE_MS],
		]);
	});

	for (const kind of ['main', 'nag'] as const) {
		it(`keeps a ${kind} job at the attempt limit retryable when recording the failure fails`, async () => {
			const { db, id } = await setup({ nag_interval_minutes: 10, nag_max_count: 3 });
			const now = jstToUtcMs('2026-11-25', 9 * 60);
			if (kind === 'nag') {
				db.raw.exec("UPDATE reminder_jobs SET status = 'cancelled'");
				db.raw.exec(
					`INSERT INTO reminder_occurrences (reminder_id, scheduled_at, state, last_message_id, channel_id) VALUES (${id}, ${now}, 'open', 'msg-x', '${CHANNEL_ID}')`,
				);
				await insertJob(
					db,
					{ reminderId: id, occurrenceId: 1, kind: 'nag', runAt: now, scheduledAt: now },
					now,
				);
			}
			db.raw.exec("UPDATE reminder_jobs SET attempt_count = 4 WHERE status = 'pending'");
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('{"message":"Missing Access"}', { status: 403 }),
			);
			const spy = failStatements(db, (query) => query.startsWith('UPDATE reminders SET status'));

			await dispatchDueJobs({ db, rest, now: () => now });
			spy.mockRestore();

			// 状態が確定していないため、試行回数の上限にかかわらず再試行できる状態に残る
			expect((await getReminder(db, id))?.status).toBe('active');
			expect(jobs(db).find((job) => job.kind === kind && job.status !== 'cancelled')).toMatchObject({
				status: 'pending',
			});

			await dispatchDueJobs({ db, rest, now: () => now + MINUTE_MS });
			expect((await getReminder(db, id))?.status).toBe('error');
			expect(jobs(db).find((job) => job.kind === kind && job.status !== 'cancelled')).toMatchObject({
				status: 'failed',
			});
			if (kind === 'main') {
				expect(occurrences(db)).toMatchObject([{ state: 'superseded' }]);
			}
		});
	}

	it('repairs a once reminder whose time has already passed by sending it late', async () => {
		const { db, id } = await setup({ schedule_type: 'once', once_at: jstToUtcMs('2026-11-25', 9 * 60) });
		db.raw.exec('DELETE FROM reminder_jobs');
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 9 * 60 + 30) });
		await dispatchDueJobs({ db, rest, now: () => jstToUtcMs('2026-11-25', 9 * 60 + 31) });

		expect(calls(fetchMock)[0]?.body.content).toContain('リマインド（予定 09:00 から遅延）');
		expect((await getReminder(db, id))?.status).toBe('ended');
	});

	it('retries a main notification in the channel recorded for the occurrence', async () => {
		const { db, id } = await setup();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		db.raw.exec(
			`INSERT INTO reminder_occurrences (reminder_id, scheduled_at, state, channel_id) VALUES (${id}, ${now}, 'open', '${CHANNEL_ID}')`,
		);
		db.raw.exec('UPDATE reminder_jobs SET occurrence_id = 1 WHERE id = 1');
		db.raw.exec(`UPDATE reminders SET channel_id = '299999999999999999' WHERE id = ${id}`);
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => now });

		expect(calls(fetchMock)[0]?.url).toBe(`${API}/channels/${CHANNEL_ID}/messages`);
	});

	it('cancels follow-up jobs of a completed occurrence', async () => {
		const { db, id } = await setup();
		const now = jstToUtcMs('2026-11-25', 9 * 60);
		db.raw.exec(
			`INSERT INTO reminder_occurrences (reminder_id, scheduled_at, state, last_message_id) VALUES (${id}, ${now}, 'completed', 'msg-x')`,
		);
		await insertJob(db, { reminderId: id, occurrenceId: 1, kind: 'snooze', runAt: now - 1, scheduledAt: now }, now);
		db.raw.exec("UPDATE reminder_jobs SET status = 'cancelled' WHERE kind = 'main'");
		const fetchMock = mockDiscord();

		await dispatchDueJobs({ db, rest, now: () => now });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(jobs(db).find((job) => job.kind === 'snooze')?.status).toBe('cancelled');
	});
});
