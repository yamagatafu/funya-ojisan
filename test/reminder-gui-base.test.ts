import { ChannelType, ComponentType, InteractionType } from 'discord-api-types/v10';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderGuiBaseHandlers } from '../src/handlers/reminder-gui-base.ts';
import { jstToUtcMs } from '../src/reminder/date.ts';
import { getReminder, insertReminder, type ReminderInput, type ReminderRow } from '../src/reminder/repository.ts';
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

/** 2026-11-25 (水) 10:00 JST */
const NOW = jstToUtcMs('2026-11-25', 10 * 60);
const OTHER_USER_ID = '300000000000000001';
const OTHER_CHANNEL_ID = '200000000000000001';
const EPHEMERAL = 64;
/** VIEW_CHANNEL のみ */
const VIEW_ONLY_PERMISSIONS = String(1n << 10n);

interface Body {
	type: number;
	data: {
		flags?: number;
		content?: string;
		custom_id?: string;
		title?: string;
		components?: {
			type: number;
			component?: { custom_id: string; value?: string; default_values?: { id: string }[] };
		}[];
	};
}

async function send(db: TestDb, interaction: Record<string, unknown>): Promise<Body> {
	const app = createApp(reminderGuiBaseHandlers);
	const { ctx } = createExecutionContext();
	const response = await app.fetch(createInteractionRequest(interaction), createEnv(db), ctx);
	expect(response.status).toBe(200);
	return (await response.json()) as Body;
}

function selectInteraction(customId: string, value: string, params: { userId?: string; permissions?: string } = {}) {
	return {
		...baseInteractionFields({ member: createMember(params) }),
		type: InteractionType.MessageComponent,
		message: { id: '600000000000000000', channel_id: CHANNEL_ID, content: '', components: [] },
		data: { custom_id: customId, component_type: ComponentType.StringSelect, values: [value] },
	};
}

type FieldValue = string | string[];

/** 基本モーダルの送信 (Label の中の部品として値を送る) */
function modalInteraction(
	state: string,
	fields: Record<string, FieldValue>,
	params: { userId?: string; permissions?: string; resolved?: Record<string, unknown> } = {},
) {
	const components = Object.entries(fields).map(([customId, value], index) => {
		let component: Record<string, unknown>;
		if (customId === 'channel') {
			component = { type: ComponentType.ChannelSelect, custom_id: customId, values: value };
		} else if (customId === 'weekdays') {
			component = { type: ComponentType.CheckboxGroup, custom_id: customId, values: value };
		} else if (customId === 'nth' || customId === 'weekday') {
			component = { type: ComponentType.RadioGroup, custom_id: customId, value };
		} else {
			component = { type: ComponentType.TextInput, custom_id: customId, value };
		}
		return { type: ComponentType.Label, id: index + 1, component };
	});
	return {
		...baseInteractionFields({ member: createMember(params) }),
		type: InteractionType.ModalSubmit,
		data: {
			custom_id: `remind_base_modal;${state}`,
			components,
			...(params.resolved ? { resolved: params.resolved } : {}),
		},
	};
}

function reminders(db: TestDb): ReminderRow[] {
	return db.raw.prepare('SELECT * FROM reminders ORDER BY id').all() as unknown as ReminderRow[];
}

function expectEphemeral(body: Body, content: string | RegExp) {
	expect(body.type).toBe(4);
	expect(body.data.flags).toBe(EPHEMERAL);
	if (typeof content === 'string') {
		expect(body.data.content).toBe(content);
	} else {
		expect(body.data.content).toMatch(content);
	}
}

function reminderInput(overrides: Partial<ReminderInput> = {}): ReminderInput {
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
		weekdays_mask: (1 << 1) | (1 << 3),
		day_of_month: null,
		nth_week: null,
		start_date: '2026-11-01',
		holiday_policy: 'skip',
		pre_notify_minutes: null,
		nag_interval_minutes: null,
		nag_max_count: null,
		end_date: null,
		remaining_count: 10,
		...overrides,
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('new repeat select', () => {
	it('opens the base modal for the selected repeat with the current channel as default', async () => {
		const body = await send(createTestDb(), selectInteraction('remind_new_repeat', 'weekly'));
		expect(body.type).toBe(9);
		expect(body.data.custom_id).toBe('remind_base_modal;new:weekly');
		expect(body.data.title).toContain('毎週');
		const ids = body.data.components?.map((row) => row.component?.custom_id);
		expect(ids).toEqual(['content', 'time', 'weekdays', 'channel']);
		expect(body.data.components?.at(-1)?.component?.default_values).toEqual([{ id: CHANNEL_ID, type: 'channel' }]);
	});

	it('rejects an unknown repeat type', async () => {
		const body = await send(createTestDb(), selectInteraction('remind_new_repeat', 'hourly'));
		expectEphemeral(body, /選択メニューは無効/);
	});
});

describe('base modal submit (new)', () => {
	const cases: { repeat: string; fields: Record<string, FieldValue>; expected: Partial<ReminderRow> }[] = [
		{
			repeat: 'once',
			fields: { date: '2026-12-01' },
			expected: { schedule_type: 'once', once_at: jstToUtcMs('2026-12-01', 9 * 60) },
		},
		{ repeat: 'once', fields: {}, expected: { schedule_type: 'once', once_at: jstToUtcMs('2026-11-26', 9 * 60) } },
		{ repeat: 'daily', fields: {}, expected: { schedule_type: 'daily' } },
		{ repeat: 'weekdays', fields: {}, expected: { schedule_type: 'weekdays' } },
		{
			repeat: 'weekly',
			fields: { weekdays: ['1', '3', '5'] },
			expected: { schedule_type: 'weekly', weekdays_mask: 0b0101010 },
		},
		{
			repeat: 'biweekly',
			fields: { weekdays: ['0'] },
			expected: { schedule_type: 'biweekly', weekdays_mask: 1 },
		},
		{
			repeat: 'monthly_day',
			fields: { day: '１５' },
			expected: { schedule_type: 'monthly_day', day_of_month: 15 },
		},
		{ repeat: 'monthly_last', fields: {}, expected: { schedule_type: 'monthly_last' } },
		{
			repeat: 'monthly_nth_weekday',
			fields: { nth: '5', weekday: '2' },
			expected: { schedule_type: 'monthly_nth_weekday', nth_week: 5, weekdays_mask: 1 << 2 },
		},
	];

	for (const { repeat, fields, expected } of cases) {
		it(`registers a ${repeat} reminder (${JSON.stringify(fields)})`, async () => {
			const db = createTestDb();
			const body = await send(
				db,
				modalInteraction(`new:${repeat}`, { content: '会議', time: '09:00', ...fields, channel: [CHANNEL_ID] }),
			);
			expectEphemeral(body, /✅ リマインダ #1 を登録しました/);
			const [reminder] = reminders(db);
			expect(reminder).toMatchObject({
				content: '会議',
				channel_id: CHANNEL_ID,
				owner_id: USER_ID,
				time_of_day: 9 * 60,
				...expected,
			});
		});
	}

	it('returns validation errors without registering', async () => {
		const db = createTestDb();
		const submit = (repeat: string, fields: Record<string, FieldValue>) =>
			send(
				db,
				modalInteraction(`new:${repeat}`, { content: '会議', time: '09:00', ...fields, channel: [CHANNEL_ID] }),
			);

		expectEphemeral(await submit('once', { date: '2026-11-24' }), /すでに過ぎています/);
		expectEphemeral(await submit('weekly', { weekdays: [] }), /weekdays（曜日）を指定してください/);
		expectEphemeral(await submit('monthly_day', { day: '32' }), '日は 1〜31 の整数で入力してください。');
		expectEphemeral(await submit('monthly_day', { day: 'abc' }), '日は 1〜31 の整数で入力してください。');
		expectEphemeral(await submit('monthly_day', { day: '0' }), '日は 1〜31 の整数で入力してください。');
		expectEphemeral(await submit('monthly_nth_weekday', { nth: '6', weekday: '2' }), /第何週/);
		expectEphemeral(await submit('daily', { time: '25:00' }), /time は `HH:MM` の形式/);
		expect(reminders(db)).toHaveLength(0);
	});

	it('targets another channel using the resolved permissions', async () => {
		const db = createTestDb();
		const resolved = (permissions: string) => ({
			channels: {
				[OTHER_CHANNEL_ID]: { id: OTHER_CHANNEL_ID, type: ChannelType.GuildText, name: 'x', permissions },
			},
		});
		const fields = { content: '会議', time: '09:00', channel: [OTHER_CHANNEL_ID] };

		expectEphemeral(
			await send(db, modalInteraction('new:daily', fields, { resolved: resolved(VIEW_ONLY_PERMISSIONS) })),
			`<#${OTHER_CHANNEL_ID}> に投稿する権限がないため、リマインダを設定できません。`,
		);
		expect(reminders(db)).toHaveLength(0);

		await send(db, modalInteraction('new:daily', fields, { resolved: resolved(MEMBER_PERMISSIONS) }));
		expect(reminders(db)[0]?.channel_id).toBe(OTHER_CHANNEL_ID);
	});

	it('explains when the permissions for another channel are not provided', async () => {
		const db = createTestDb();
		const fields = { content: '会議', time: '09:00', channel: [OTHER_CHANNEL_ID] };
		const message =
			'通知先の権限を確認できませんでした。通知先のチャンネルで実行するか、/remind add の channel オプションを使ってください。';

		expectEphemeral(await send(db, modalInteraction('new:daily', fields)), message);
		expectEphemeral(
			await send(
				db,
				modalInteraction('new:daily', fields, {
					resolved: {
						channels: {
							[OTHER_CHANNEL_ID]: { id: OTHER_CHANNEL_ID, type: ChannelType.GuildText, name: 'x' },
						},
					},
				}),
			),
			message,
		);
		expect(reminders(db)).toHaveLength(0);
	});

	it('rejects a malformed state', async () => {
		const db = createTestDb();
		for (const state of ['new:hourly', 'edit:daily', 'edit:daily:0', 'new:daily:1', 'x']) {
			const body = await send(
				db,
				modalInteraction(state, { content: '会議', time: '09:00', channel: [CHANNEL_ID] }),
			);
			expectEphemeral(body, 'この入力画面は無効です。もう一度やり直してください。');
		}
		expect(reminders(db)).toHaveLength(0);
	});

	it('rejects submissions outside a guild', async () => {
		const interaction = modalInteraction('new:daily', { content: '会議', time: '09:00', channel: [CHANNEL_ID] });
		const { guild_id: _guild, member: _member, ...dm } = interaction;
		const body = await send(createTestDb(), { ...dm, user: createMember({}).user });
		expectEphemeral(body, 'この操作はサーバー内でのみ使用できます。');
	});
});

describe('edit repeat select', () => {
	it('opens the base modal prefilled with the current values', async () => {
		const db = createTestDb();
		const id = await insertReminder(db, reminderInput(), NOW);
		const body = await send(db, selectInteraction(`remind_edit_repeat;${id}`, 'weekly'));
		expect(body.type).toBe(9);
		expect(body.data.custom_id).toBe(`remind_base_modal;edit:weekly:${id}`);
		const byId = new Map(body.data.components?.map((row) => [row.component?.custom_id, row.component]));
		expect(byId.get('content')?.value).toBe('ゴミ出し');
		expect(byId.get('time')?.value).toBe('09:00');
		expect(byId.get('channel')?.default_values).toEqual([{ id: CHANNEL_ID, type: 'channel' }]);
	});

	it('opens the modal for a different repeat type', async () => {
		const db = createTestDb();
		const id = await insertReminder(db, reminderInput(), NOW);
		const body = await send(db, selectInteraction(`remind_edit_repeat;${id}`, 'monthly_day'));
		expect(body.data.custom_id).toBe(`remind_base_modal;edit:monthly_day:${id}`);
	});

	it('lets server managers edit others but rejects other members and other guilds', async () => {
		const db = createTestDb();
		const id = await insertReminder(db, reminderInput(), NOW);
		const otherGuildId = await insertReminder(db, reminderInput({ guild_id: '100000000000000001' }), NOW);

		expectEphemeral(
			await send(db, selectInteraction(`remind_edit_repeat;${id}`, 'weekly', { userId: OTHER_USER_ID })),
			`リマインダ #${id} が見つかりません。`,
		);
		expectEphemeral(
			await send(db, selectInteraction(`remind_edit_repeat;${otherGuildId}`, 'weekly')),
			`リマインダ #${otherGuildId} が見つかりません。`,
		);
		expectEphemeral(
			await send(db, selectInteraction('remind_edit_repeat;999', 'weekly')),
			'リマインダ #999 が見つかりません。',
		);
		expectEphemeral(await send(db, selectInteraction('remind_edit_repeat;abc', 'weekly')), /#\? が見つかりません/);

		const body = await send(
			db,
			selectInteraction(`remind_edit_repeat;${id}`, 'weekly', {
				userId: OTHER_USER_ID,
				permissions: SERVER_MANAGER_PERMISSIONS,
			}),
		);
		expect(body.type).toBe(9);
	});
});

describe('base modal submit (edit)', () => {
	it('replaces the base settings with the same repeat type', async () => {
		const db = createTestDb();
		const id = await insertReminder(db, reminderInput(), NOW);
		const body = await send(
			db,
			modalInteraction(`edit:weekly:${id}`, {
				content: '資源ごみ',
				time: '07:30',
				weekdays: ['5'],
				channel: [CHANNEL_ID],
			}),
		);
		expectEphemeral(body, new RegExp(`✏️ リマインダ #${id} を更新しました`));
		expect(await getReminder(db, id)).toMatchObject({
			content: '資源ごみ',
			time_of_day: 7 * 60 + 30,
			weekdays_mask: 1 << 5,
			// 期間・祝日は基本モーダルの対象外のため保つ
			start_date: '2026-11-01',
			holiday_policy: 'skip',
			remaining_count: 10,
		});
	});

	it('changes the repeat type', async () => {
		const db = createTestDb();
		const id = await insertReminder(db, reminderInput(), NOW);
		await send(
			db,
			modalInteraction(`edit:monthly_nth_weekday:${id}`, {
				content: 'ゴミ出し',
				time: '09:00',
				nth: '2',
				weekday: '4',
				channel: [CHANNEL_ID],
			}),
		);
		expect(await getReminder(db, id)).toMatchObject({
			schedule_type: 'monthly_nth_weekday',
			nth_week: 2,
			weekdays_mask: 1 << 4,
		});

		await send(
			db,
			modalInteraction(`edit:daily:${id}`, { content: 'ゴミ出し', time: '09:00', channel: [CHANNEL_ID] }),
		);
		expect(await getReminder(db, id)).toMatchObject({
			schedule_type: 'daily',
			weekdays_mask: null,
			nth_week: null,
		});
	});

	it('changes a repeating reminder with a holiday policy to once', async () => {
		const db = createTestDb();
		const id = await insertReminder(db, reminderInput(), NOW);
		const body = await send(
			db,
			modalInteraction(`edit:once:${id}`, {
				content: 'ゴミ出し',
				date: '',
				time: '09:00',
				channel: [CHANNEL_ID],
			}),
		);
		expectEphemeral(body, new RegExp(`✏️ リマインダ #${id} を更新しました`));
		expect(await getReminder(db, id)).toMatchObject({
			schedule_type: 'once',
			once_at: jstToUtcMs('2026-11-26', 9 * 60),
			holiday_policy: 'notify',
			weekdays_mask: null,
			remaining_count: null,
		});
	});

	it('uses the next occurrence when the date of a once reminder is cleared', async () => {
		const db = createTestDb();
		const id = await insertReminder(
			db,
			reminderInput({
				schedule_type: 'once',
				once_at: jstToUtcMs('2026-12-10', 9 * 60),
				weekdays_mask: null,
				start_date: null,
				holiday_policy: 'notify',
				remaining_count: null,
			}),
			NOW,
		);
		await send(
			db,
			modalInteraction(`edit:once:${id}`, {
				content: 'ゴミ出し',
				date: '',
				time: '11:00',
				channel: [CHANNEL_ID],
			}),
		);
		expect((await getReminder(db, id))?.once_at).toBe(jstToUtcMs('2026-11-25', 11 * 60));

		await send(
			db,
			modalInteraction(`edit:once:${id}`, {
				content: 'ゴミ出し',
				date: '2026-12-20',
				time: '11:00',
				channel: [CHANNEL_ID],
			}),
		);
		expect((await getReminder(db, id))?.once_at).toBe(jstToUtcMs('2026-12-20', 11 * 60));
	});

	it('rejects edits by other members', async () => {
		const db = createTestDb();
		const id = await insertReminder(db, reminderInput(), NOW);
		const body = await send(
			db,
			modalInteraction(
				`edit:daily:${id}`,
				{ content: '乗っ取り', time: '09:00', channel: [CHANNEL_ID] },
				{ userId: OTHER_USER_ID },
			),
		);
		expectEphemeral(body, `リマインダ #${id} が見つかりません。`);
		expect((await getReminder(db, id))?.content).toBe('ゴミ出し');
	});
});
