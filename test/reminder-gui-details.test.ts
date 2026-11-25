import { ComponentType, InteractionType, SelectMenuDefaultValueType } from 'discord-api-types/v10';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderGuiDetailHandlers } from '../src/handlers/reminder-gui-details.ts';
import { jstToUtcMs } from '../src/reminder/date.ts';
import { NOTIFY_FIELD, PERIOD_FIELD, parseNotifySettingsValues } from '../src/reminder/gui-details.ts';
import { getReminder, insertReminder, type ReminderInput, type ReminderRow } from '../src/reminder/repository.ts';
import { scheduleUpcoming } from '../src/reminder/service.ts';
import { createTestDb } from './helpers/d1.ts';
import {
	baseInteractionFields,
	CHANNEL_ID,
	createApp,
	createEnv,
	createExecutionContext,
	createInteractionRequest,
	createMember,
	GUILD_ID,
	MEMBER_PERMISSIONS,
	SERVER_MANAGER_PERMISSIONS,
	USER_ID,
} from './helpers/interaction.ts';

type TestDb = ReturnType<typeof createTestDb>;

/** 2026-11-25 (水) 08:00 JST */
const NOW = jstToUtcMs('2026-11-25', 8 * 60);
const OTHER_USER_ID = '300000000000000001';
const OTHER_CHANNEL_ID = '200000000000000001';
const OTHER_GUILD_ID = '100000000000000001';
const ROLE_ID = '500000000000000000';
/** MEMBER_PERMISSIONS | MENTION_EVERYONE */
const MENTION_EVERYONE_PERMISSIONS = String(BigInt(MEMBER_PERMISSIONS) | (1n << 17n));

interface ActorParams {
	userId?: string;
	permissions?: string;
	channelId?: string;
}

interface Body {
	type: number;
	data: {
		content?: string;
		flags?: number;
		custom_id?: string;
		title?: string;
		components?: { component: Record<string, unknown> & { custom_id: string } }[];
	};
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

async function seed(db: TestDb, overrides: Partial<ReminderInput> = {}): Promise<ReminderRow> {
	const id = await insertReminder(db, input(overrides), NOW);
	await scheduleUpcoming(db, (await getReminder(db, id))!, NOW, NOW);
	return (await getReminder(db, id))!;
}

function buttonInteraction(customId: string, actor: ActorParams = {}) {
	return {
		...baseInteractionFields({
			member: createMember({ userId: actor.userId, permissions: actor.permissions }),
			channelId: actor.channelId,
		}),
		type: InteractionType.MessageComponent,
		data: { component_type: ComponentType.Button, custom_id: customId },
	};
}

type ModalValue = { text: string } | { radio: string | null } | { mentionable: string[] };

function modalInteraction(
	customId: string,
	values: Record<string, ModalValue>,
	actor: ActorParams & { resolved?: Record<string, unknown> } = {},
) {
	return {
		...baseInteractionFields({
			member: createMember({ userId: actor.userId, permissions: actor.permissions }),
			channelId: actor.channelId,
		}),
		type: InteractionType.ModalSubmit,
		data: {
			custom_id: customId,
			components: Object.entries(values).map(([custom_id, value], index) => ({
				type: ComponentType.Label,
				id: index + 1,
				component:
					'text' in value
						? { type: ComponentType.TextInput, custom_id, value: value.text }
						: 'radio' in value
							? { type: ComponentType.RadioGroup, custom_id, value: value.radio }
							: { type: ComponentType.MentionableSelect, custom_id, values: value.mentionable },
			})),
			...(actor.resolved ? { resolved: actor.resolved } : {}),
		},
	};
}

async function send(db: TestDb, interaction: Record<string, unknown>): Promise<Body> {
	const app = createApp(reminderGuiDetailHandlers);
	const { ctx, flush } = createExecutionContext();
	const response = await app.fetch(createInteractionRequest(interaction), createEnv(db), ctx);
	await flush();
	expect(response.status).toBe(200);
	return (await response.json()) as Body;
}

function expectEphemeral(body: Body, content: string | RegExp) {
	expect(body.type).toBe(4);
	expect(body.data.flags).toBe(64);
	if (typeof content === 'string') {
		expect(body.data.content).toBe(content);
	} else {
		expect(body.data.content).toMatch(content);
	}
}

function fields(body: Body): Record<string, Record<string, unknown>> {
	return Object.fromEntries((body.data.components ?? []).map(({ component }) => [component.custom_id, component]));
}

const text = (value: string) => ({ text: value });

function notifyValues(values: { mention?: string[]; pre?: string; interval?: string; max?: string }) {
	return {
		[NOTIFY_FIELD.mention]: { mentionable: values.mention ?? [] },
		[NOTIFY_FIELD.preNotify]: text(values.pre ?? ''),
		[NOTIFY_FIELD.nagInterval]: text(values.interval ?? ''),
		[NOTIFY_FIELD.nagMax]: text(values.max ?? ''),
	};
}

function periodValues(values: { date?: string; holidays?: string | null; until?: string; count?: string }) {
	return {
		[PERIOD_FIELD.date]: text(values.date ?? ''),
		[PERIOD_FIELD.holidays]: { radio: values.holidays === undefined ? 'notify' : values.holidays },
		[PERIOD_FIELD.until]: text(values.until ?? ''),
		[PERIOD_FIELD.count]: text(values.count ?? ''),
	};
}

const roles = (id: string, mentionable: boolean) => ({
	roles: { [id]: { id, name: 'role', mentionable, permissions: '0', position: 1 } },
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('[通知設定]', () => {
	it('opens the modal prefilled with the current values', async () => {
		const db = createTestDb();
		const reminder = await seed(db, {
			mention_type: 'user',
			mention_target_id: OTHER_USER_ID,
			pre_notify_minutes: 10,
			nag_interval_minutes: 30,
			nag_max_count: 5,
		});

		const body = await send(db, buttonInteraction(`remind_notify_settings;${reminder.id}`));

		expect(body.type).toBe(9);
		expect(body.data.custom_id).toBe(`remind_notify_modal;${reminder.id}`);
		expect(body.data.title).toBe(`リマインダ #${reminder.id} の通知設定`);
		const byId = fields(body);
		expect(Object.keys(byId)).toEqual(['mention', 'pre_notify', 'nag_interval', 'nag_max']);
		expect(byId.mention).toMatchObject({
			type: ComponentType.MentionableSelect,
			required: false,
			default_values: [{ id: OTHER_USER_ID, type: SelectMenuDefaultValueType.User }],
		});
		expect(byId.pre_notify).toMatchObject({ type: ComponentType.TextInput, required: false, value: '10' });
		expect(byId.nag_interval).toMatchObject({ value: '30' });
		expect(byId.nag_max).toMatchObject({ value: '5' });
		expect(body.data.components?.[0]).toMatchObject({ label: 'メンション先', description: '未選択なら自分' });
	});

	it('leaves the fields empty for a self mention without notifications', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const byId = fields(await send(db, buttonInteraction(`remind_notify_settings;${reminder.id}`)));

		expect(byId.mention).not.toHaveProperty('default_values');
		expect(byId.pre_notify).not.toHaveProperty('value');
		expect(byId.nag_interval).not.toHaveProperty('value');
		expect(byId.nag_max).not.toHaveProperty('value');
	});

	it('selects the current role', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { mention_type: 'role', mention_target_id: ROLE_ID });

		const byId = fields(await send(db, buttonInteraction(`remind_notify_settings;${reminder.id}`)));

		expect(byId.mention).toMatchObject({
			default_values: [{ id: ROLE_ID, type: SelectMenuDefaultValueType.Role }],
		});
	});

	it('saves the values and returns the summary', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const body = await send(
			db,
			modalInteraction(
				`remind_notify_modal;${reminder.id}`,
				notifyValues({ mention: [OTHER_USER_ID], pre: '１５', interval: '30', max: '4' }),
				{ resolved: { users: { [OTHER_USER_ID]: { id: OTHER_USER_ID, username: 'other' } } } },
			),
		);

		expectEphemeral(body, new RegExp(`^✏️ リマインダ #${reminder.id} を更新しました`));
		expect(body.data).toMatchObject({ allowed_mentions: { parse: [] } });
		expect(body.data.components).toHaveLength(1);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			mention_type: 'user',
			mention_target_id: OTHER_USER_ID,
			pre_notify_minutes: 15,
			nag_interval_minutes: 30,
			nag_max_count: 4,
		});
	});

	it('uses the default nag count when the count is blank', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		await send(db, modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({ interval: '30' })));

		expect(await getReminder(db, reminder.id)).toMatchObject({ nag_interval_minutes: 30, nag_max_count: 3 });
	});

	it('clears the values when the fields are blank', async () => {
		const db = createTestDb();
		const reminder = await seed(db, {
			mention_type: 'user',
			mention_target_id: OTHER_USER_ID,
			pre_notify_minutes: 10,
			nag_interval_minutes: 30,
			nag_max_count: 5,
		});

		const body = await send(db, modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({})));

		expectEphemeral(body, /を更新しました/);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			mention_type: 'self',
			mention_target_id: null,
			pre_notify_minutes: null,
			nag_interval_minutes: null,
			nag_max_count: null,
		});
	});

	it('saves unchanged values (no "nothing to change" error)', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const body = await send(db, modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({})));

		expectEphemeral(body, /を更新しました/);
	});

	it.each([
		['pre', 'abc', '「事前通知（分）」は 0〜1440 の整数で入力してください。'],
		['pre', '1.5', '「事前通知（分）」は 0〜1440 の整数で入力してください。'],
		['pre', '1441', '「事前通知（分）」は 0〜1440 の整数で入力してください。'],
		['interval', '-5', '「完了まで再通知する間隔（分）」は 0〜1440 の整数で入力してください。'],
		['max', '11', '「再通知の最大回数」は 1〜10 の整数で入力してください。'],
	])('rejects an invalid number (%s: %s)', async (field, value, message) => {
		const db = createTestDb();
		const reminder = await seed(db, { pre_notify_minutes: 10 });

		const body = await send(
			db,
			modalInteraction(
				`remind_notify_modal;${reminder.id}`,
				notifyValues({ interval: '30', ...{ [field]: value } }),
			),
		);

		expectEphemeral(body, message);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			pre_notify_minutes: 10,
			revision: reminder.revision,
		});
	});

	it('clears nagging when only the interval is blank, even if a max count remains', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { nag_interval_minutes: 30, nag_max_count: 5 });

		for (const max of ['5', '11', 'abc']) {
			// 範囲外・不正な値が残っていても、間隔が空欄なら検証せずに解除する
			const body = await send(db, modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({ max })));
			expect(body.data.content).toContain('を更新しました');
		}
		expect(await getReminder(db, reminder.id)).toMatchObject({ nag_interval_minutes: null });
	});

	it('rejects a too short interval', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		expectEphemeral(
			await send(db, modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({ interval: '3' }))),
			/5 分以上/,
		);
	});

	it('rejects a role mention without permission', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const customId = `remind_notify_modal;${reminder.id}`;
		const values = notifyValues({ mention: [ROLE_ID] });

		expectEphemeral(
			await send(db, modalInteraction(customId, values, { resolved: roles(ROLE_ID, false) })),
			'このロールをメンションする権限がありません。',
		);
		expect((await getReminder(db, reminder.id))?.mention_type).toBe('self');

		await send(
			db,
			modalInteraction(customId, values, {
				resolved: roles(ROLE_ID, false),
				permissions: MENTION_EVERYONE_PERMISSIONS,
			}),
		);
		expect(await getReminder(db, reminder.id)).toMatchObject({ mention_type: 'role', mention_target_id: ROLE_ID });
	});

	it('keeps an unchanged role mention without re-checking the role', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { mention_type: 'role', mention_target_id: ROLE_ID });

		const body = await send(
			db,
			modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({ mention: [ROLE_ID], pre: '5' }), {
				resolved: roles(ROLE_ID, false),
			}),
		);

		expectEphemeral(body, /を更新しました/);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			mention_type: 'role',
			mention_target_id: ROLE_ID,
			pre_notify_minutes: 5,
		});
	});

	it('maps a blank mention of another owner reminder to the owner (self)', () => {
		const reminder = { mention_type: 'user' as const, mention_target_id: OTHER_USER_ID, owner_id: USER_ID };
		const result = parseNotifySettingsValues(reminder, { [NOTIFY_FIELD.mention]: [] });
		expect(result).toEqual({ ok: true, value: { pre_notify: 0, nag_interval: 0, mention: USER_ID } });
	});
});

describe('[期間・祝日]', () => {
	it('opens the modal prefilled with the current values', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { holiday_policy: 'shift', end_date: '2026-12-31', remaining_count: 7 });

		const body = await send(db, buttonInteraction(`remind_period_settings;${reminder.id}`));

		expect(body.type).toBe(9);
		expect(body.data.custom_id).toBe(`remind_period_modal;${reminder.id}`);
		expect(body.data.title).toBe(`リマインダ #${reminder.id} の期間・祝日`);
		const byId = fields(body);
		expect(Object.keys(byId)).toEqual(['date', 'holidays', 'until', 'count']);
		expect(byId.date).toMatchObject({ type: ComponentType.TextInput, required: false, value: '2026-11-25' });
		expect(byId.holidays).toMatchObject({
			type: ComponentType.RadioGroup,
			options: [
				{ value: 'notify', label: '通知する', default: false },
				{ value: 'skip', label: 'スキップ', default: false },
				{ value: 'shift', label: '次の平日にずらす', default: true },
			],
		});
		expect(byId.until).toMatchObject({ value: '2026-12-31' });
		expect(byId.count).toMatchObject({ value: '7' });
	});

	it('rejects a one-time reminder', async () => {
		const db = createTestDb();
		const reminder = await seed(db, {
			schedule_type: 'once',
			once_at: jstToUtcMs('2026-11-26', 9 * 60),
			weekdays_mask: null,
			start_date: null,
		});

		expectEphemeral(
			await send(db, buttonInteraction(`remind_period_settings;${reminder.id}`)),
			'1回のみのリマインダには期間・祝日を設定できません。',
		);
	});

	it('saves the values', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const body = await send(
			db,
			modalInteraction(
				`remind_period_modal;${reminder.id}`,
				periodValues({ date: '2026-12-01', holidays: 'skip', until: '2027-03-31', count: '12' }),
			),
		);

		expectEphemeral(body, new RegExp(`^✏️ リマインダ #${reminder.id} を更新しました`));
		expect(await getReminder(db, reminder.id)).toMatchObject({
			start_date: '2026-12-01',
			holiday_policy: 'skip',
			end_date: '2027-03-31',
			remaining_count: 12,
		});
	});

	it('clears the end date and the count when blank (start date is kept)', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { end_date: '2026-12-31', remaining_count: 7 });

		const body = await send(db, modalInteraction(`remind_period_modal;${reminder.id}`, periodValues({})));

		expectEphemeral(body, /を更新しました/);
		expect(await getReminder(db, reminder.id)).toMatchObject({
			start_date: '2026-11-25',
			end_date: null,
			remaining_count: null,
		});
	});

	it('keeps an unchanged start date in the past', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { start_date: '2026-10-01' });

		const body = await send(
			db,
			modalInteraction(`remind_period_modal;${reminder.id}`, periodValues({ date: '2026-10-01', count: '3' })),
		);

		expectEphemeral(body, /を更新しました/);
		expect(await getReminder(db, reminder.id)).toMatchObject({ start_date: '2026-10-01', remaining_count: 3 });
	});

	it.each([
		[{ count: 'x' }, '「回数」は 0〜1000 の整数で入力してください。'],
		[{ count: '1001' }, '「回数」は 0〜1000 の整数で入力してください。'],
		[{ until: '2026-13-40' }, /until は/],
		[{ until: '2026-11-01' }, /今日以降/],
		[{ date: 'あした' }, /date は/],
	])('rejects invalid input %o', async (values, message) => {
		const db = createTestDb();
		const reminder = await seed(db, { remaining_count: 7 });

		const body = await send(db, modalInteraction(`remind_period_modal;${reminder.id}`, periodValues(values)));

		expectEphemeral(body, message);
		expect((await getReminder(db, reminder.id))?.revision).toBe(reminder.revision);
	});
});

describe('access control', () => {
	it.each([
		['remind_notify_settings', 'button'],
		['remind_period_settings', 'button'],
		['remind_notify_modal', 'modal'],
		['remind_period_modal', 'modal'],
	])('rejects a non-owner (%s)', async (prefix, kind) => {
		const db = createTestDb();
		const reminder = await seed(db);
		const customId = `${prefix};${reminder.id}`;
		const actor = { userId: OTHER_USER_ID };

		const body = await send(
			db,
			kind === 'button'
				? buttonInteraction(customId, actor)
				: modalInteraction(customId, prefix.includes('notify') ? notifyValues({}) : periodValues({}), actor),
		);

		expectEphemeral(body, `リマインダ #${reminder.id} が見つかりません。`);
		expect((await getReminder(db, reminder.id))?.revision).toBe(reminder.revision);
	});

	it('allows a server manager to edit another member reminder', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { pre_notify_minutes: 10 });

		const body = await send(
			db,
			modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({}), {
				userId: OTHER_USER_ID,
				permissions: SERVER_MANAGER_PERMISSIONS,
			}),
		);

		expectEphemeral(body, /を更新しました/);
		// メンション先の空欄は、操作した人ではなく登録者 (自分) のまま
		expect(await getReminder(db, reminder.id)).toMatchObject({ mention_type: 'self', pre_notify_minutes: null });
	});

	it.each([
		['remind_notify_settings', 'button'],
		['remind_period_modal', 'modal'],
	])('rejects a reminder from another guild (%s)', async (prefix, kind) => {
		const db = createTestDb();
		const reminder = await seed(db, { guild_id: OTHER_GUILD_ID });
		const customId = `${prefix};${reminder.id}`;

		const body = await send(
			db,
			kind === 'button'
				? buttonInteraction(customId, { permissions: SERVER_MANAGER_PERMISSIONS })
				: modalInteraction(customId, periodValues({}), { permissions: SERVER_MANAGER_PERMISSIONS }),
		);

		expectEphemeral(body, `リマインダ #${reminder.id} が見つかりません。`);
		expect((await getReminder(db, reminder.id))?.revision).toBe(reminder.revision);
	});

	it('rejects an invalid or missing reminder id', async () => {
		const db = createTestDb();

		expectEphemeral(
			await send(db, buttonInteraction('remind_notify_settings;abc')),
			'リマインダ #? が見つかりません。',
		);
		expectEphemeral(
			await send(db, buttonInteraction('remind_period_settings;999')),
			'リマインダ #999 が見つかりません。',
		);
	});

	it('asks to use the reminder channel when saved from another channel', async () => {
		// 実行者の権限は実行したチャンネルの分しか分からないため、/remind edit と同じく通知先での操作を求める
		const db = createTestDb();
		const reminder = await seed(db);

		const body = await send(
			db,
			modalInteraction(`remind_notify_modal;${reminder.id}`, notifyValues({ pre: '5' }), {
				channelId: OTHER_CHANNEL_ID,
			}),
		);

		expectEphemeral(body, /通知先 <#200000000000000000> への投稿権限を確認するため/);
		expect((await getReminder(db, reminder.id))?.pre_notify_minutes).toBeNull();
	});
});
