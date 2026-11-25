import { ApplicationCommandOptionType, ChannelType, InteractionType } from 'discord-api-types/v10';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderCommandHandlers } from '../src/handlers/reminder-commands.ts';
import { jstToUtcMs, MINUTE_MS } from '../src/reminder/date.ts';
import { buildScheduleForAdd, buildScheduleForEdit, buildScheduleForRelative } from '../src/reminder/options.ts';
import {
	getReminder,
	insertOccurrence,
	insertReminder,
	type JobRow,
	type ReminderInput,
	type ReminderRow,
	updateOccurrence,
	updateReminder,
} from '../src/reminder/repository.ts';
import { createReminder, scheduleUpcoming } from '../src/reminder/service.ts';
import { createTestDb } from './helpers/d1.ts';
import {
	APPLICATION_ID,
	baseInteractionFields,
	CHANNEL_ID,
	createApp,
	createEnv,
	createExecutionContext,
	createInteractionRequest,
	createMember,
	GUILD_ID,
	MEMBER_PERMISSIONS,
	MODERATOR_PERMISSIONS,
	USER_ID,
} from './helpers/interaction.ts';

type TestDb = ReturnType<typeof createTestDb>;

/** 2026-11-25 (水) 08:00 JST */
const NOW = jstToUtcMs('2026-11-25', 8 * 60);
const OTHER_USER_ID = '300000000000000001';
const OTHER_CHANNEL_ID = '200000000000000001';
const ROLE_ID = '500000000000000000';
/** MEMBER_PERMISSIONS | MENTION_EVERYONE */
const MENTION_EVERYONE_PERMISSIONS = String(BigInt(MEMBER_PERMISSIONS) | (1n << 17n));
/** VIEW_CHANNEL のみ */
const VIEW_ONLY_PERMISSIONS = String(1n << 10n);

interface Option {
	name: string;
	type: number;
	value: string | number | boolean;
	focused?: boolean;
}

function opt(name: string, value: string | number | boolean): Option {
	const type =
		typeof value === 'string'
			? ApplicationCommandOptionType.String
			: typeof value === 'number'
				? ApplicationCommandOptionType.Integer
				: ApplicationCommandOptionType.Boolean;
	return { name, type, value };
}

function channelOpt(id: string): Option {
	return { name: 'channel', type: ApplicationCommandOptionType.Channel, value: id };
}

function mentionOpt(id: string): Option {
	return { name: 'mention', type: ApplicationCommandOptionType.Mentionable, value: id };
}

interface InteractionParams {
	userId?: string;
	permissions?: string;
	resolved?: Record<string, unknown>;
	channelId?: string;
}

function commandInteraction(sub: string, options: Option[], params: InteractionParams = {}) {
	return {
		...baseInteractionFields({
			member: createMember({ userId: params.userId, permissions: params.permissions }),
			channelId: params.channelId,
		}),
		type: InteractionType.ApplicationCommand,
		data: {
			id: '600000000000000000',
			name: 'remind',
			type: 1,
			options: [{ type: ApplicationCommandOptionType.Subcommand, name: sub, options }],
			...(params.resolved ? { resolved: params.resolved } : {}),
		},
	};
}

function autocompleteInteraction(sub: string, value: string, params: InteractionParams = {}) {
	return {
		...commandInteraction(
			sub,
			[{ name: 'id', type: ApplicationCommandOptionType.Integer, value, focused: true }],
			params,
		),
		type: InteractionType.ApplicationCommandAutocomplete,
	};
}

async function send(db: TestDb, interaction: Record<string, unknown>) {
	const app = createApp(reminderCommandHandlers);
	const { ctx, flush } = createExecutionContext();
	const response = await app.fetch(createInteractionRequest(interaction), createEnv(db), ctx);
	await flush();
	return (await response.json()) as {
		type: number;
		data: { content: string; flags?: number; choices?: { name: string; value: number }[] };
	};
}

async function run(db: TestDb, sub: string, options: Option[], params: InteractionParams = {}): Promise<string> {
	const body = await send(db, commandInteraction(sub, options, params));
	expect(body.type).toBe(4);
	expect(body.data.flags).toBe(64);
	return body.data.content;
}

function reminders(db: TestDb): ReminderRow[] {
	return db.raw.prepare('SELECT * FROM reminders ORDER BY id').all() as unknown as ReminderRow[];
}

function jobs(db: TestDb, reminderId?: number): JobRow[] {
	const all = db.raw.prepare('SELECT * FROM reminder_jobs ORDER BY id').all() as unknown as JobRow[];
	return reminderId === undefined ? all : all.filter((job) => job.reminder_id === reminderId);
}

function input(overrides: Partial<ReminderInput> = {}): ReminderInput {
	return {
		guild_id: GUILD_ID,
		channel_id: CHANNEL_ID,
		owner_id: USER_ID,
		content: 'ゴミ出し',
		source_message_url: null,
		mention_type: 'self',
		mention_target_id: null,
		schedule_type: 'weekly',
		time_of_day: 9 * 60,
		once_at: null,
		weekdays_mask: 0b0101010, // 月水金
		day_of_month: null,
		nth_week: null,
		start_date: '2026-11-25',
		holiday_policy: 'notify',
		pre_notify_minutes: null,
		nag_interval_minutes: null,
		nag_max_count: null,
		end_date: null,
		remaining_count: null,
		...overrides,
	};
}

/** 件数の上限を経由せずに登録する (上限を超える件数を用意するテスト用) */
async function seed(db: TestDb, overrides: Partial<ReminderInput> = {}): Promise<ReminderRow> {
	const id = await insertReminder(db, input(overrides), NOW);
	await scheduleUpcoming(db, (await getReminder(db, id))!, NOW, NOW);
	return (await getReminder(db, id))!;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('/remind add', () => {
	it('registers a once reminder for today when the time is still ahead', async () => {
		const db = createTestDb();
		const content = await run(db, 'add', [opt('content', '会議'), opt('time', '09:30')]);

		expect(content).toContain('✅ リマインダ #1 を登録しました');
		expect(content).toContain('1回のみ 2026-11-25 09:30');
		expect(content).toContain(`<t:${jstToUtcMs('2026-11-25', 9 * 60 + 30) / 1000}:F>`);
		const [row] = reminders(db);
		expect(row).toMatchObject({
			guild_id: GUILD_ID,
			channel_id: CHANNEL_ID,
			owner_id: USER_ID,
			content: '会議',
			mention_type: 'self',
			schedule_type: 'once',
			once_at: jstToUtcMs('2026-11-25', 9 * 60 + 30),
			holiday_policy: 'notify',
			status: 'active',
		});
		expect(jobs(db).map((job) => [job.kind, job.run_at])).toEqual([
			['main', jstToUtcMs('2026-11-25', 9 * 60 + 30)],
		]);
	});

	it('uses tomorrow when the time has already passed today, and resolves dates without a year', async () => {
		const db = createTestDb();
		await run(db, 'add', [opt('content', 'a'), opt('time', '07:00')]);
		await run(db, 'add', [opt('content', 'b'), opt('time', '07:00'), opt('date', '11/25')]);
		await run(db, 'add', [opt('content', 'c'), opt('time', '10:00'), opt('date', '1/5')]);

		expect(reminders(db).map((row) => row.once_at)).toEqual([
			jstToUtcMs('2026-11-26', 7 * 60),
			jstToUtcMs('2027-11-25', 7 * 60),
			jstToUtcMs('2027-01-05', 10 * 60),
		]);
	});

	it('registers a weekly reminder with every option', async () => {
		const db = createTestDb();
		const content = await run(db, 'add', [
			opt('content', 'ゴミ出し'),
			opt('time', '9:00'),
			opt('repeat', 'weekly'),
			opt('weekdays', '月水金'),
			opt('date', '2026-11-30'),
			opt('holidays', 'skip'),
			opt('until', '2026-12-31'),
			opt('count', 5),
			opt('pre_notify', 10),
			opt('nag_interval', 15),
		]);

		expect(content).toContain('毎週 月水金 09:00（祝日はスキップ・〜2026-12-31・残り5回）');
		expect(content).toContain('事前通知: 10分前');
		expect(content).toContain('完了まで再通知: 15分おき・最大3回');
		expect(reminders(db)[0]).toMatchObject({
			schedule_type: 'weekly',
			time_of_day: 9 * 60,
			weekdays_mask: 0b0101010,
			start_date: '2026-11-30',
			holiday_policy: 'skip',
			end_date: '2026-12-31',
			remaining_count: 5,
			pre_notify_minutes: 10,
			nag_interval_minutes: 15,
			nag_max_count: 3,
			next_run_at: jstToUtcMs('2026-11-30', 9 * 60),
		});
	});

	it('registers monthly schedules', async () => {
		const db = createTestDb();
		await run(db, 'add', [opt('content', 'a'), opt('time', '09:00'), opt('repeat', 'monthly_day'), opt('day', 31)]);
		await run(db, 'add', [
			opt('content', 'b'),
			opt('time', '09:00'),
			opt('repeat', 'monthly_nth_weekday'),
			opt('weekdays', '火'),
			opt('nth', 5),
		]);
		expect(
			reminders(db).map((row) => [row.day_of_month, row.weekdays_mask, row.nth_week, row.next_run_at]),
		).toEqual([
			[31, null, null, jstToUtcMs('2026-11-30', 9 * 60)],
			[null, 0b100, 5, jstToUtcMs('2026-12-29', 9 * 60)],
		]);
	});

	it.each(['skip', 'shift'])('rejects holidays:%s for a once reminder', async (policy) => {
		const db = createTestDb();
		expect(await run(db, 'add', [opt('content', 'a'), opt('time', '09:00'), opt('holidays', policy)])).toBe(
			'1回のみのリマインダには祝日の扱いを指定できません',
		);
		expect(
			await run(db, 'add', [
				opt('content', 'a'),
				opt('time', '09:00'),
				opt('repeat', 'once'),
				opt('holidays', policy),
			]),
		).toBe('1回のみのリマインダには祝日の扱いを指定できません');
		expect(reminders(db)).toHaveLength(0);
	});

	it('allows holidays:notify for a once reminder', async () => {
		const db = createTestDb();
		expect(await run(db, 'add', [opt('content', 'a'), opt('time', '09:00'), opt('holidays', 'notify')])).toContain(
			'✅',
		);
	});

	it('rejects options that do not apply to the repeat type', async () => {
		const db = createTestDb();
		expect(
			await run(db, 'add', [
				opt('content', 'a'),
				opt('time', '09:00'),
				opt('until', '2026-12-31'),
				opt('count', 3),
			]),
		).toBe('繰り返し「1回のみ」では次のオプションは指定できません: until, count');
		expect(
			await run(db, 'add', [
				opt('content', 'a'),
				opt('time', '09:00'),
				opt('repeat', 'daily'),
				opt('weekdays', '月'),
				opt('day', 3),
			]),
		).toBe('繰り返し「毎日」では次のオプションは指定できません: weekdays, day');
		expect(reminders(db)).toHaveLength(0);
	});

	it('rejects inconsistent or invalid input', async () => {
		const db = createTestDb();
		const cases: [Option[], string][] = [
			[[opt('time', '09:00'), opt('date', '2026-11-24')], 'すでに過ぎています'],
			[[opt('time', '07:59'), opt('date', '2026-11-25')], 'すでに過ぎています'],
			[[opt('time', '25:00')], 'HH:MM'],
			[[opt('time', '09:00'), opt('date', '2026-02-30')], 'YYYY-MM-DD'],
			[[opt('time', '09:00'), opt('repeat', 'weekly')], 'weekdays（曜日）を指定してください'],
			[[opt('time', '09:00'), opt('repeat', 'biweekly'), opt('weekdays', 'あ')], '曜日を並べて'],
			[[opt('time', '09:00'), opt('repeat', 'monthly_day')], 'day（日付 1〜31）'],
			[
				[opt('time', '09:00'), opt('repeat', 'monthly_nth_weekday'), opt('weekdays', '月火'), opt('nth', 1)],
				'1 つだけ',
			],
			[[opt('time', '09:00'), opt('repeat', 'monthly_nth_weekday'), opt('weekdays', '月')], 'nth'],
			[[opt('time', '09:00'), opt('nag_max', 3)], 'nag_max は nag_interval'],
			[[opt('time', '09:00'), opt('repeat', 'daily'), opt('until', '2026-11-24')], '今日以降'],
			[
				[opt('time', '09:00'), opt('repeat', 'daily'), opt('date', '2026-12-10'), opt('until', '2026-12-01')],
				'開始日より前',
			],
			[
				[opt('time', '07:00'), opt('repeat', 'daily'), opt('until', '2026-11-25')],
				'条件に合う通知日時がありません',
			],
			[[opt('content', '   '), opt('time', '09:00')], 'content（内容）を入力してください'],
		];
		for (const [options, expected] of cases) {
			const withContent = options.some((option) => option.name === 'content')
				? options
				: [opt('content', 'a'), ...options];
			expect(await run(db, 'add', withContent)).toContain(expected);
		}
		expect(reminders(db)).toHaveLength(0);
	});

	it('targets another channel only when the invoker can post there', async () => {
		const db = createTestDb();
		const resolved = (permissions: string, type: number = ChannelType.GuildText) => ({
			channels: { [OTHER_CHANNEL_ID]: { id: OTHER_CHANNEL_ID, type, permissions, name: 'x' } },
		});

		expect(
			await run(db, 'add', [opt('content', 'a'), opt('time', '09:00'), channelOpt(OTHER_CHANNEL_ID)], {
				resolved: resolved(VIEW_ONLY_PERMISSIONS),
			}),
		).toBe(`<#${OTHER_CHANNEL_ID}> に投稿する権限がないため、リマインダを設定できません。`);
		expect(
			await run(db, 'add', [opt('content', 'a'), opt('time', '09:00'), channelOpt(OTHER_CHANNEL_ID)], {
				resolved: resolved(MEMBER_PERMISSIONS, ChannelType.GuildVoice),
			}),
		).toContain('このチャンネルにはリマインダを設定できません');
		expect(reminders(db)).toHaveLength(0);

		await run(db, 'add', [opt('content', 'a'), opt('time', '09:00'), channelOpt(OTHER_CHANNEL_ID)], {
			resolved: resolved(MEMBER_PERMISSIONS),
		});
		expect(reminders(db)[0]?.channel_id).toBe(OTHER_CHANNEL_ID);
	});

	it('validates mention targets', async () => {
		const db = createTestDb();
		const roles = (id: string, mentionable: boolean) => ({
			roles: { [id]: { id, name: 'role', mentionable, permissions: '0', position: 1 } },
		});
		const base = [opt('content', 'a'), opt('time', '09:00')];

		expect(await run(db, 'add', [...base, mentionOpt(GUILD_ID)], { resolved: roles(GUILD_ID, true) })).toBe(
			'@everyone はメンション先に指定できません。',
		);
		expect(await run(db, 'add', [...base, mentionOpt(ROLE_ID)], { resolved: roles(ROLE_ID, false) })).toBe(
			'このロールをメンションする権限がありません。',
		);
		expect(reminders(db)).toHaveLength(0);

		await run(db, 'add', [...base, mentionOpt(ROLE_ID)], {
			resolved: roles(ROLE_ID, false),
			permissions: MENTION_EVERYONE_PERMISSIONS,
		});
		await run(db, 'add', [...base, mentionOpt(ROLE_ID)], { resolved: roles(ROLE_ID, true) });
		await run(db, 'add', [...base, mentionOpt(OTHER_USER_ID)], {
			resolved: { users: { [OTHER_USER_ID]: { id: OTHER_USER_ID, username: 'other' } } },
		});
		await run(db, 'add', [...base, mentionOpt(USER_ID)], {
			resolved: { users: { [USER_ID]: { id: USER_ID, username: 'me' } } },
		});
		expect(reminders(db).map((row) => [row.mention_type, row.mention_target_id])).toEqual([
			['role', ROLE_ID],
			['role', ROLE_ID],
			['user', OTHER_USER_ID],
			['self', null],
		]);
	});

	it('enforces the per-user limit', async () => {
		const db = createTestDb();
		for (let i = 0; i < 25; i++) {
			await seed(db);
		}
		expect(await run(db, 'add', [opt('content', 'a'), opt('time', '09:00')])).toContain('1 人 25 件まで');
		// 他のユーザーは登録できる
		expect(await run(db, 'add', [opt('content', 'a'), opt('time', '09:00')], { userId: OTHER_USER_ID })).toContain(
			'✅',
		);
	});
});

describe('/remind in', () => {
	it('does not notify before the requested duration when run in the middle of a minute', () => {
		// 08:00:59 に 1 分後を指定すると、08:01:59 を切り上げた 08:02:00 に通知する
		const result = buildScheduleForRelative({ minutes: 1 }, NOW + 59 * 1000);
		expect(result).toMatchObject({ ok: true, value: { once_at: NOW + 2 * MINUTE_MS } });
	});

	it('registers a once reminder relative to now', async () => {
		const db = createTestDb();
		const content = await run(db, 'in', [opt('content', 'お湯'), opt('hours', 1), opt('minutes', 30)]);
		expect(content).toContain('✅ リマインダ #1 を登録しました');
		expect(reminders(db)[0]).toMatchObject({
			schedule_type: 'once',
			once_at: NOW + 90 * MINUTE_MS,
			time_of_day: 9 * 60 + 30,
			holiday_policy: 'notify',
		});
	});

	it('rejects empty or too long durations', async () => {
		const db = createTestDb();
		expect(await run(db, 'in', [opt('content', 'a')])).toContain('1 分以上');
		expect(await run(db, 'in', [opt('content', 'a'), opt('minutes', 0)])).toContain('1 分以上');
		expect(await run(db, 'in', [opt('content', 'a'), opt('days', 365), opt('minutes', 1)])).toContain('365 日以内');
		expect(reminders(db)).toHaveLength(0);
	});

	it('applies the same permission checks as add', async () => {
		const db = createTestDb();
		expect(
			await run(db, 'in', [opt('content', 'a'), opt('minutes', 5), channelOpt(OTHER_CHANNEL_ID)], {
				resolved: {
					channels: {
						[OTHER_CHANNEL_ID]: { id: OTHER_CHANNEL_ID, type: 0, permissions: VIEW_ONLY_PERMISSIONS },
					},
				},
			}),
		).toContain('投稿する権限がない');
	});
});

describe('/remind edit', () => {
	it('updates fields and reschedules jobs', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { pre_notify_minutes: 10 });

		const content = await run(db, 'edit', [
			opt('id', reminder.id),
			opt('time', '10:00'),
			opt('content', '資源ごみ'),
		]);

		expect(content).toContain(`✏️ リマインダ #${reminder.id} を更新しました`);
		expect(content).toContain('毎週 月水金 10:00');
		const row = await getReminder(db, reminder.id);
		expect(row).toMatchObject({
			content: '資源ごみ',
			time_of_day: 600,
			next_run_at: jstToUtcMs('2026-11-25', 600),
		});
		expect(jobs(db).map((job) => [job.kind, job.status, job.run_at])).toEqual([
			['main', 'cancelled', jstToUtcMs('2026-11-25', 540)],
			['pre', 'cancelled', jstToUtcMs('2026-11-25', 530)],
			['main', 'pending', jstToUtcMs('2026-11-25', 600)],
			['pre', 'pending', jstToUtcMs('2026-11-25', 590)],
		]);
	});

	it('keeps the date of a once reminder when only the time changes', async () => {
		const db = createTestDb();
		const reminder = await seed(db, {
			schedule_type: 'once',
			once_at: jstToUtcMs('2026-12-01', 9 * 60),
			weekdays_mask: null,
			start_date: null,
		});
		await run(db, 'edit', [opt('id', reminder.id), opt('time', '18:15')]);
		expect((await getReminder(db, reminder.id))?.once_at).toBe(jstToUtcMs('2026-12-01', 18 * 60 + 15));
	});

	it.each(['skip', 'shift'])('rejects holidays:%s on a once reminder after the merge', async (policy) => {
		const db = createTestDb();
		const once = await seed(db, {
			schedule_type: 'once',
			once_at: jstToUtcMs('2026-12-01', 9 * 60),
			weekdays_mask: null,
			start_date: null,
		});
		expect(await run(db, 'edit', [opt('id', once.id), opt('holidays', policy)])).toBe(
			'1回のみのリマインダには祝日の扱いを指定できません',
		);

		const weekly = await seed(db, { holiday_policy: policy as 'skip' | 'shift' });
		// once に変えても祝日の扱いは自動では戻さない
		expect(await run(db, 'edit', [opt('id', weekly.id), opt('repeat', 'once')])).toBe(
			'1回のみのリマインダには祝日の扱いを指定できません',
		);
		expect((await getReminder(db, weekly.id))?.schedule_type).toBe('weekly');

		// holidays:通知する を同時に指定すれば変更できる
		expect(
			await run(db, 'edit', [opt('id', weekly.id), opt('repeat', 'once'), opt('holidays', 'notify')]),
		).toContain('✏️');
		expect(await getReminder(db, weekly.id)).toMatchObject({
			schedule_type: 'once',
			holiday_policy: 'notify',
			weekdays_mask: null,
			start_date: null,
			once_at: jstToUtcMs('2026-11-25', 9 * 60),
		});
	});

	it('silently clears fields that no longer apply, but rejects explicit ones', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { end_date: '2026-12-31', remaining_count: 4 });

		expect(await run(db, 'edit', [opt('id', reminder.id), opt('day', 5)])).toBe(
			'繰り返し「毎週」では次のオプションは指定できません: day',
		);
		expect(await run(db, 'edit', [opt('id', reminder.id), opt('repeat', 'monthly_last')])).toContain('✏️');
		expect(await getReminder(db, reminder.id)).toMatchObject({
			schedule_type: 'monthly_last',
			weekdays_mask: null,
			end_date: '2026-12-31',
			remaining_count: 4,
			start_date: '2026-11-25',
		});

		expect(await run(db, 'edit', [opt('id', reminder.id), opt('repeat', 'once'), opt('date', '12/24')])).toContain(
			'✏️',
		);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			schedule_type: 'once',
			once_at: jstToUtcMs('2026-12-24', 9 * 60),
			end_date: null,
			remaining_count: null,
			start_date: null,
		});
	});

	it('turns features off with 0 / なし', async () => {
		const db = createTestDb();
		const reminder = await seed(db, {
			pre_notify_minutes: 10,
			nag_interval_minutes: 30,
			nag_max_count: 5,
			end_date: '2026-12-31',
			remaining_count: 3,
		});
		await run(db, 'edit', [
			opt('id', reminder.id),
			opt('pre_notify', 0),
			opt('nag_interval', 0),
			opt('until', 'なし'),
			opt('count', 0),
		]);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			pre_notify_minutes: null,
			nag_interval_minutes: null,
			nag_max_count: null,
			end_date: null,
			remaining_count: null,
		});
		expect(await run(db, 'edit', [opt('id', reminder.id), opt('nag_max', 2)])).toContain('nag_max は nag_interval');
	});

	it('rejects a change without a next occurrence and keeps the reminder as is', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { schedule_type: 'daily', weekdays_mask: null, time_of_day: 9 * 60 });
		expect(
			await run(db, 'edit', [opt('id', reminder.id), opt('time', '07:00'), opt('until', '2026-11-25')]),
		).toContain('条件に合う通知日時がありません');
		expect(await getReminder(db, reminder.id)).toMatchObject({ time_of_day: 9 * 60, end_date: null });
		expect(jobs(db, reminder.id).map((job) => job.status)).toEqual(['pending']);
	});

	it('keeps a paused reminder paused without scheduling', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		await run(db, 'pause', [opt('id', reminder.id)]);
		await run(db, 'edit', [opt('id', reminder.id), opt('time', '12:00')]);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			status: 'paused',
			time_of_day: 12 * 60,
			next_run_at: null,
		});
		expect(jobs(db, reminder.id).every((job) => job.status === 'cancelled')).toBe(true);
	});

	it('reactivates errored reminders', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		await updateReminder(db, reminder.id, { status: 'error', last_error: 'status=403' }, NOW);
		await run(db, 'edit', [opt('id', reminder.id), opt('weekdays', '火')]);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			status: 'active',
			last_error: null,
			weekdays_mask: 0b100,
			next_run_at: jstToUtcMs('2026-12-01', 9 * 60),
		});
	});

	it('allows only the owner or a moderator in the same guild', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const otherGuild = await seed(db, { guild_id: '100000000000000001' });

		expect(await run(db, 'edit', [opt('id', reminder.id), opt('time', '10:00')], { userId: OTHER_USER_ID })).toBe(
			`リマインダ #${reminder.id} が見つかりません。`,
		);
		expect(await run(db, 'edit', [opt('id', otherGuild.id), opt('time', '10:00')])).toBe(
			`リマインダ #${otherGuild.id} が見つかりません。`,
		);
		expect(await run(db, 'edit', [opt('id', 999), opt('time', '10:00')])).toBe(
			'リマインダ #999 が見つかりません。',
		);
		expect(await run(db, 'delete', [opt('id', reminder.id)], { userId: OTHER_USER_ID })).toContain(
			'見つかりません',
		);
		expect(await run(db, 'pause', [opt('id', reminder.id)], { userId: OTHER_USER_ID })).toContain('見つかりません');

		expect(
			await run(db, 'edit', [opt('id', reminder.id), opt('time', '10:00')], {
				userId: OTHER_USER_ID,
				permissions: MODERATOR_PERMISSIONS,
			}),
		).toContain('✏️');
		// 管理者が編集しても、所有者は変わらない
		expect(await getReminder(db, reminder.id)).toMatchObject({ owner_id: USER_ID, time_of_day: 600 });
	});

	it('validates a new channel and mention', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		expect(
			await run(db, 'edit', [opt('id', reminder.id), channelOpt(OTHER_CHANNEL_ID)], {
				resolved: {
					channels: {
						[OTHER_CHANNEL_ID]: { id: OTHER_CHANNEL_ID, type: 0, permissions: VIEW_ONLY_PERMISSIONS },
					},
				},
			}),
		).toContain('投稿する権限がない');
		expect(
			await run(db, 'edit', [opt('id', reminder.id), mentionOpt(GUILD_ID)], {
				resolved: { roles: { [GUILD_ID]: { id: GUILD_ID, mentionable: true } } },
			}),
		).toContain('@everyone');
		expect(await run(db, 'edit', [opt('id', reminder.id)])).toContain('変更する項目');
	});
});

describe('/remind list', () => {
	it('lists the invoker reminders', async () => {
		const db = createTestDb();
		const own = await seed(db, { content: '自分の\nリマインダ' });
		await seed(db, { owner_id: OTHER_USER_ID, content: '他の人' });
		const ended = await seed(db, { content: '終了済み' });
		await updateReminder(db, ended.id, { status: 'ended' }, NOW);

		const content = await run(db, 'list', []);
		expect(content).toContain('📋 あなたのリマインダ（1 件）');
		expect(content).toContain(
			`- \`#${own.id}\` 🟢 有効 · 毎週 月水金 09:00 · <#${CHANNEL_ID}> · 次回 <t:${jstToUtcMs('2026-11-25', 540) / 1000}:R> · 自分の リマインダ`,
		);
		expect(content).not.toContain('他の人');
		expect(content).not.toContain('終了済み');
	});

	it('lists the whole guild for moderators only', async () => {
		const db = createTestDb();
		await seed(db);
		await seed(db, { owner_id: OTHER_USER_ID, content: '他の人' });

		expect(await run(db, 'list', [opt('all', true)])).toContain('メッセージの管理権限');
		const content = await run(db, 'list', [opt('all', true)], { permissions: MODERATOR_PERMISSIONS });
		expect(content).toContain('このサーバーのリマインダ（2 件）');
		expect(content).toContain(`<@${OTHER_USER_ID}>`);
	});

	it('shows at most 25 lines and stays under 2000 characters', async () => {
		const db = createTestDb();
		for (let i = 0; i < 30; i++) {
			await seed(db, { content: 'あ'.repeat(100) });
		}
		const content = await run(db, 'list', []);
		expect(content.length).toBeLessThanOrEqual(2000);
		const lines = content.split('\n').filter((line) => line.startsWith('- '));
		expect(lines.length).toBeLessThanOrEqual(25);
		expect(content).toContain(`他 ${30 - lines.length} 件`);
		expect(lines[0]).toContain(`${'あ'.repeat(39)}…`);
	});

	it('reports an empty list', async () => {
		expect(await run(createTestDb(), 'list', [])).toBe('登録しているリマインダはありません。');
	});
});

describe('/remind delete', () => {
	it('deletes the reminder with its jobs', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		expect(await run(db, 'delete', [opt('id', reminder.id)])).toBe(`🗑️ リマインダ #${reminder.id} を削除しました。`);
		expect(reminders(db)).toHaveLength(0);
		expect(jobs(db)).toHaveLength(0);
	});

	it('removes buttons from open notifications', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const occurrenceId = await insertOccurrence(db, reminder.id, NOW, reminder.channel_id);
		await updateOccurrence(db, occurrenceId, { last_message_id: 'msg-1' });
		// 通知の送信後に通知先を変更しても、ボタンは送信したチャンネルで外す
		db.raw.exec(`UPDATE reminders SET channel_id = '${OTHER_CHANNEL_ID}' WHERE id = ${reminder.id}`);
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));

		const body = await send(db, commandInteraction('delete', [opt('id', reminder.id)]));

		expect(body.type).toBe(5);
		expect(body.data.flags).toBe(64);
		const requests = fetchMock.mock.calls.map(([url, init]) => ({
			url: String(url),
			method: init?.method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		}));
		expect(requests).toEqual([
			{
				url: `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/msg-1`,
				method: 'PATCH',
				body: { components: [] },
			},
			{
				url: `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/interaction-token/messages/@original`,
				method: 'PATCH',
				body: expect.objectContaining({
					content: `🗑️ リマインダ #${reminder.id} を削除しました。`,
					allowed_mentions: { parse: [] },
				}),
			},
		]);
		expect(reminders(db)).toHaveLength(0);
	});
});

describe('/remind pause and resume', () => {
	it('pauses and resumes a reminder', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { pre_notify_minutes: 10 });

		expect(await run(db, 'pause', [opt('id', reminder.id)])).toContain(
			`⏸️ リマインダ #${reminder.id} を一時停止しました`,
		);
		expect(await getReminder(db, reminder.id)).toMatchObject({ status: 'paused', next_run_at: null });
		expect(jobs(db).map((job) => job.status)).toEqual(['cancelled', 'cancelled']);
		expect(await run(db, 'pause', [opt('id', reminder.id)])).toBe(
			`リマインダ #${reminder.id} は一時停止できません（現在: ⏸️ 一時停止中）。`,
		);

		vi.setSystemTime(jstToUtcMs('2026-11-25', 12 * 60));
		const content = await run(db, 'resume', [opt('id', reminder.id)]);
		expect(content).toContain(`▶️ リマインダ #${reminder.id} を再開しました`);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			status: 'active',
			next_run_at: jstToUtcMs('2026-11-27', 9 * 60),
		});
		expect(jobs(db).filter((job) => job.status === 'pending')).toHaveLength(2);
		expect(await run(db, 'resume', [opt('id', reminder.id)])).toContain('再開できません');
	});

	it('resumes an errored reminder', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		await updateReminder(db, reminder.id, { status: 'error', last_error: 'status=403' }, NOW);
		await run(db, 'resume', [opt('id', reminder.id)]);
		expect(await getReminder(db, reminder.id)).toMatchObject({ status: 'active', last_error: null });
		// 残っていた予定は取り消し、重複させない
		expect(jobs(db).filter((job) => job.status === 'pending')).toHaveLength(1);
	});

	it('ends a reminder that has no next occurrence on resume', async () => {
		const db = createTestDb();
		const reminder = await seed(db, {
			schedule_type: 'once',
			once_at: jstToUtcMs('2026-11-25', 9 * 60),
			weekdays_mask: null,
			start_date: null,
		});
		await run(db, 'pause', [opt('id', reminder.id)]);
		vi.setSystemTime(jstToUtcMs('2026-11-25', 10 * 60));
		expect(await run(db, 'resume', [opt('id', reminder.id)])).toContain('次回の通知日時がないため');
		expect((await getReminder(db, reminder.id))?.status).toBe('ended');
	});
});

describe('/remind id autocomplete', () => {
	async function choices(db: TestDb, sub: string, value: string, params: InteractionParams = {}) {
		const body = await send(db, autocompleteInteraction(sub, value, params));
		expect(body.type).toBe(8);
		return body.data.choices ?? [];
	}

	it('suggests the invoker reminders', async () => {
		const db = createTestDb();
		const own = await seed(db);
		await seed(db, { owner_id: OTHER_USER_ID, content: '他の人' });
		const paused = await seed(db, { content: '止めたもの', schedule_type: 'daily', weekdays_mask: null });
		await updateReminder(db, paused.id, { status: 'paused' }, NOW);
		const ended = await seed(db, { content: '終わったもの' });
		await updateReminder(db, ended.id, { status: 'ended' }, NOW);

		expect(await choices(db, 'edit', '')).toEqual([
			{ name: `#${own.id} 毎週 月水金 09:00 ゴミ出し`, value: own.id },
			{ name: `#${paused.id} ⏸️ 毎日 09:00 止めたもの`, value: paused.id },
		]);
	});

	it('suggests the whole guild for moderators and filters by the input', async () => {
		const db = createTestDb();
		for (let i = 0; i < 12; i++) {
			await seed(db, { owner_id: i % 2 === 0 ? USER_ID : OTHER_USER_ID, content: `用事${i}` });
		}
		const params = { permissions: MODERATOR_PERMISSIONS };
		expect(await choices(db, 'delete', '', params)).toHaveLength(12);
		expect((await choices(db, 'pause', '1', params)).map((choice) => choice.value)).toEqual([1, 2, 10, 11, 12]);
		expect((await choices(db, 'resume', '#12', params)).map((choice) => choice.value)).toEqual([12]);
		expect((await choices(db, 'edit', '用事3', params)).map((choice) => choice.value)).toEqual([4]);
	});

	it('limits choices to 25 and names to 100 characters', async () => {
		const db = createTestDb();
		for (let i = 0; i < 30; i++) {
			await seed(db, { owner_id: `3${String(i).padStart(17, '0')}`, content: 'い'.repeat(200) });
		}
		const result = await choices(db, 'edit', '', { permissions: MODERATOR_PERMISSIONS });
		expect(result).toHaveLength(25);
		expect(result.every((choice) => Array.from(choice.name).length <= 100)).toBe(true);
	});
});

describe('schedule options', () => {
	it('builds and merges schedules as pure functions', () => {
		const added = buildScheduleForAdd({ time: '09:00', repeat: 'biweekly', weekdays: '火' }, NOW);
		expect(added).toMatchObject({ ok: true, value: { start_date: '2026-11-25', weekdays_mask: 0b100 } });
		if (!added.ok) {
			return;
		}
		expect(buildScheduleForEdit(added.value, { repeat: 'monthly_nth_weekday', nth: 2 }, NOW)).toMatchObject({
			ok: true,
			value: { schedule_type: 'monthly_nth_weekday', weekdays_mask: 0b100, nth_week: 2 },
		});
		expect(buildScheduleForEdit(added.value, { nag_interval: 3 }, NOW)).toMatchObject({ ok: false });
	});
});

describe('atomicity', () => {
	it('enforces the per-user limit inside the insert itself', async () => {
		const db = createTestDb();
		for (let i = 0; i < 25; i++) {
			await seed(db);
		}
		const result = await createReminder(db, input(), NOW);
		expect(result).toMatchObject({ ok: false });
		expect(reminders(db)).toHaveLength(25);
	});

	it('creates the reminder and its first jobs in one transaction', async () => {
		const db = createTestDb();
		const batch = db.batch.bind(db);
		// リマインダの登録後、ジョブの登録の途中で失敗した状況を再現する (最後に失敗する文を足す)
		vi.spyOn(db, 'batch').mockImplementationOnce((statements) =>
			batch([...statements, db.prepare('INSERT INTO no_such_table VALUES (1)')]),
		);
		await expect(createReminder(db, input({ pre_notify_minutes: 10 }), NOW)).rejects.toThrow();
		expect(reminders(db)).toHaveLength(0);
		expect(jobs(db)).toHaveLength(0);

		const result = await createReminder(db, input({ pre_notify_minutes: 10 }), NOW);
		expect(result.ok).toBe(true);
		const [reminder] = reminders(db);
		expect(jobs(db).map((job) => [job.reminder_id, job.kind, job.status])).toEqual([
			[reminder!.id, 'main', 'pending'],
			[reminder!.id, 'pre', 'pending'],
		]);
		expect(reminder?.next_run_at).toBe(jobs(db)[0]?.run_at);
	});

	it('creates no jobs when the limit is reached', async () => {
		const db = createTestDb();
		for (let i = 0; i < 25; i++) {
			await seed(db);
		}
		const before = jobs(db).length;
		expect(await createReminder(db, input(), NOW)).toMatchObject({ ok: false });
		expect(jobs(db)).toHaveLength(before);
	});

	it('keeps the existing schedule when an edit fails midway', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const before = jobs(db, reminder.id);

		const batchSpy = vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 unavailable'));

		expect(await run(db, 'edit', [opt('id', reminder.id), opt('time', '10:00')])).toBe(
			'エラーが発生しました。時間をおいて再度お試しください。',
		);
		expect(batchSpy).toHaveBeenCalledTimes(1);
		expect(jobs(db, reminder.id)).toEqual(before);
		expect(await getReminder(db, reminder.id)).toEqual(reminder);
	});

	it('keeps the paused state when a resume fails midway', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		await run(db, 'pause', [opt('id', reminder.id)]);
		const batchSpy = vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 unavailable'));

		expect(await run(db, 'resume', [opt('id', reminder.id)])).toBe(
			'エラーが発生しました。時間をおいて再度お試しください。',
		);
		expect(batchSpy).toHaveBeenCalledTimes(1);

		expect((await getReminder(db, reminder.id))?.status).toBe('paused');
		expect(jobs(db, reminder.id).filter((job) => job.status === 'pending')).toHaveLength(0);
	});

	it('enforces the limit when reviving an ended reminder even if a registration races', async () => {
		const db = createTestDb();
		const ended = await seed(db);
		db.raw.exec(`UPDATE reminders SET status = 'ended', next_run_at = NULL WHERE id = ${ended.id}`);
		db.raw.exec("UPDATE reminder_jobs SET status = 'cancelled'");
		for (let i = 0; i < 24; i++) {
			await seed(db);
		}
		const batch = db.batch.bind(db);
		// 事前確認の後、batch の前に別の登録が入った状況を再現する
		vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
			await seed(db);
			return batch(statements);
		});

		const content = await run(db, 'edit', [opt('id', ended.id), opt('time', '10:00')]);

		expect(content).toContain('上限に達しているため');
		expect((await getReminder(db, ended.id))?.status).toBe('ended');
		expect(jobs(db, ended.id).filter((job) => job.status === 'pending')).toHaveLength(0);
	});

	it('rejects an edit when the reminder was changed after it was read', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const before = jobs(db, reminder.id);
		const batch = db.batch.bind(db);
		vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
			// 読み取り後、batch の前に通知処理などがリマインダを更新した状況を再現する
			db.raw.exec(`UPDATE reminders SET revision = revision + 1 WHERE id = ${reminder.id}`);
			return batch(statements);
		});

		expect(await run(db, 'edit', [opt('id', reminder.id), opt('time', '10:00')])).toContain(
			'同時に更新されたため、変更を保存できませんでした',
		);
		expect(jobs(db, reminder.id)).toEqual(before);
		expect((await getReminder(db, reminder.id))?.time_of_day).toBe(reminder.time_of_day);
	});

	it('does not revive past the limit when an active reminder ends after being read', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		for (let i = 0; i < 24; i++) {
			await seed(db);
		}
		const batch = db.batch.bind(db);
		vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
			// 読み取り時は active だったが、batch の前に終了し、空いた枠に別の登録が入った状況を再現する
			db.raw.exec(
				`UPDATE reminders SET status = 'ended', next_run_at = NULL, revision = revision + 1 WHERE id = ${reminder.id}`,
			);
			await seed(db);
			return batch(statements);
		});

		expect(await run(db, 'edit', [opt('id', reminder.id), opt('time', '10:00')])).toContain('同時に更新されたため');
		expect((await getReminder(db, reminder.id))?.status).toBe('ended');
		expect(reminders(db).filter((row) => row.status !== 'ended')).toHaveLength(25);
	});

	it('does not lose the schedule when two edits revive the same reminder concurrently', async () => {
		const db = createTestDb();
		const ended = await seed(db);
		db.raw.exec(`UPDATE reminders SET status = 'ended', next_run_at = NULL WHERE id = ${ended.id}`);
		db.raw.exec("UPDATE reminder_jobs SET status = 'cancelled'");
		const batch = db.batch.bind(db);
		let raced = false;
		vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
			if (!raced) {
				// 1 つ目の編集の batch の前に、2 つ目の編集が先に復活させた状況を再現する
				raced = true;
				await run(db, 'edit', [opt('id', ended.id), opt('time', '11:00')]);
			}
			return batch(statements);
		});

		expect(await run(db, 'edit', [opt('id', ended.id), opt('time', '10:00')])).toContain('同時に更新されたため');
		const reminder = await getReminder(db, ended.id);
		expect(reminder).toMatchObject({ status: 'active', time_of_day: 11 * 60 });
		expect(jobs(db, ended.id).filter((job) => job.status === 'pending')).toHaveLength(1);
	});
});

describe('permission checks on the current target', () => {
	it('asks to run edit in the target channel or to specify a channel', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		expect(
			await run(db, 'edit', [opt('id', reminder.id), opt('content', '変更')], { channelId: OTHER_CHANNEL_ID }),
		).toContain('channel オプションで通知先を指定してください');
		expect((await getReminder(db, reminder.id))?.content).toBe(reminder.content);
	});

	it('rejects edit and resume when the actor can no longer post to the target', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		await run(db, 'pause', [opt('id', reminder.id)]);

		expect(
			await run(db, 'edit', [opt('id', reminder.id), opt('content', '変更')], {
				permissions: VIEW_ONLY_PERMISSIONS,
			}),
		).toContain('投稿する権限がない');
		expect(await run(db, 'resume', [opt('id', reminder.id)], { permissions: VIEW_ONLY_PERMISSIONS })).toContain(
			'投稿する権限がない',
		);
		expect((await getReminder(db, reminder.id))?.status).toBe('paused');
	});

	it('asks to run resume in the target channel', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		await run(db, 'pause', [opt('id', reminder.id)]);
		expect(await run(db, 'resume', [opt('id', reminder.id)], { channelId: OTHER_CHANNEL_ID })).toContain(
			'通知先のチャンネルで実行してください',
		);
		expect((await getReminder(db, reminder.id))?.status).toBe('paused');
	});

	it('re-validates a stored role mention when only the channel changes', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { mention_type: 'role', mention_target_id: ROLE_ID });
		const resolved = {
			channels: { [OTHER_CHANNEL_ID]: { id: OTHER_CHANNEL_ID, type: 0, permissions: MEMBER_PERMISSIONS } },
		};
		expect(await run(db, 'edit', [opt('id', reminder.id), channelOpt(OTHER_CHANNEL_ID)], { resolved })).toContain(
			'mention でロールを指定し直してください',
		);
		expect((await getReminder(db, reminder.id))?.channel_id).toBe(CHANNEL_ID);

		const allowed = {
			channels: {
				[OTHER_CHANNEL_ID]: { id: OTHER_CHANNEL_ID, type: 0, permissions: MENTION_EVERYONE_PERMISSIONS },
			},
		};
		expect(
			await run(db, 'edit', [opt('id', reminder.id), channelOpt(OTHER_CHANNEL_ID)], { resolved: allowed }),
		).toContain('を更新しました');
	});
});
