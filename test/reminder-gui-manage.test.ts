import { ApplicationCommandOptionType, ButtonStyle, ComponentType, InteractionType } from 'discord-api-types/v10';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderCommandHandlers } from '../src/handlers/reminder-commands.ts';
import { reminderGuiManageHandlers } from '../src/handlers/reminder-gui-manage.ts';
import { jstToUtcMs } from '../src/reminder/date.ts';
import {
	EDIT_REPEAT_SELECT_ID,
	MANAGE_DELETE_BUTTON_ID,
	MANAGE_DELETE_CANCEL_BUTTON_ID,
	MANAGE_DELETE_CONFIRM_BUTTON_ID,
	MANAGE_EDIT_BUTTON_ID,
	MANAGE_SELECT_ID,
	MANAGE_TOGGLE_BUTTON_ID,
	NOTIFY_SETTINGS_BUTTON_ID,
	PERIOD_SETTINGS_BUTTON_ID,
} from '../src/reminder/gui.ts';
import {
	getReminder,
	insertOccurrence,
	insertReminder,
	type ReminderInput,
	type ReminderRow,
	updateOccurrence,
	updateReminder,
} from '../src/reminder/repository.ts';
import { scheduleUpcoming } from '../src/reminder/service.ts';
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
	SERVER_MANAGER_PERMISSIONS,
	USER_ID,
} from './helpers/interaction.ts';

type TestDb = ReturnType<typeof createTestDb>;

/** 2026-11-25 (水) 08:00 JST */
const NOW = jstToUtcMs('2026-11-25', 8 * 60);
const OTHER_USER_ID = '300000000000000001';
const OTHER_GUILD_ID = '100000000000000001';
const EPHEMERAL = 64;

interface Actor {
	userId?: string;
	permissions?: string;
}

interface Component {
	type: number;
	custom_id?: string;
	label?: string;
	style?: number;
	placeholder?: string;
	options?: { label: string; value: string; default?: boolean }[];
	components?: Component[];
}

interface Body {
	type: number;
	data?: { content: string; flags?: number; components?: Component[] };
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

async function send(db: TestDb, interaction: Record<string, unknown>): Promise<Body> {
	const app = createApp([...reminderCommandHandlers, ...reminderGuiManageHandlers]);
	const { ctx, flush } = createExecutionContext();
	const response = await app.fetch(createInteractionRequest(interaction), createEnv(db), ctx);
	await flush();
	return (await response.json()) as Body;
}

function listCommand(actor: Actor = {}, all = false) {
	return {
		...baseInteractionFields({ member: createMember(actor) }),
		type: InteractionType.ApplicationCommand,
		data: {
			id: '600000000000000000',
			name: 'remind',
			type: 1,
			options: [
				{
					type: ApplicationCommandOptionType.Subcommand,
					name: 'list',
					options: all ? [{ name: 'all', type: ApplicationCommandOptionType.Boolean, value: true }] : [],
				},
			],
		},
	};
}

/** Ephemeral のメッセージ上の部品の操作 */
function componentInteraction(data: Record<string, unknown>, actor: Actor = {}, guildId = GUILD_ID) {
	return {
		...baseInteractionFields({ member: createMember(actor) }),
		guild_id: guildId,
		type: InteractionType.MessageComponent,
		message: {
			id: 'ephemeral-1',
			channel_id: CHANNEL_ID,
			content: '',
			flags: EPHEMERAL,
			components: [],
		},
		data,
	};
}

function select(id: number | string, actor: Actor = {}, guildId = GUILD_ID) {
	return componentInteraction(
		{ component_type: ComponentType.StringSelect, custom_id: MANAGE_SELECT_ID, values: [String(id)] },
		actor,
		guildId,
	);
}

function button(customId: string, actor: Actor = {}, guildId = GUILD_ID) {
	return componentInteraction({ component_type: ComponentType.Button, custom_id: customId }, actor, guildId);
}

function rows(body: Body): Component[][] {
	return (body.data?.components ?? []).map((row) => row.components ?? []);
}

function customIds(body: Body): (string | undefined)[][] {
	return rows(body).map((row) => row.map((component) => component.custom_id));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('/remind list の選択メニュー', () => {
	it('一覧と同じリマインダを選択肢にする', async () => {
		const db = createTestDb();
		const own = await seed(db, { content: '自分の\nリマインダ' });
		const paused = await seed(db, { content: '止めたもの' });
		await updateReminder(db, paused.id, { status: 'paused', next_run_at: null }, NOW);
		await seed(db, { owner_id: OTHER_USER_ID, content: '他の人' });

		const body = await send(db, listCommand());

		expect(body.type).toBe(4);
		expect(body.data?.flags).toBe(EPHEMERAL);
		expect(body.data?.content).toContain('📋 あなたのリマインダ（2 件）');
		const [[menu]] = rows(body);
		expect(menu).toMatchObject({
			type: ComponentType.StringSelect,
			custom_id: MANAGE_SELECT_ID,
			placeholder: '操作するリマインダを選ぶ',
		});
		expect(menu?.options).toEqual([
			{ label: `#${own.id} 毎週 月水金 09:00 自分の リマインダ`, value: String(own.id) },
			{ label: `#${paused.id} ⏸️ 毎週 月水金 09:00 止めたもの`, value: String(paused.id) },
		]);
	});

	it('all ではサーバー全体を対象にし、最大 25 件・100 文字以内にする', async () => {
		const db = createTestDb();
		for (let i = 0; i < 30; i++) {
			await seed(db, { owner_id: i % 2 === 0 ? USER_ID : OTHER_USER_ID, content: 'あ'.repeat(200) });
		}
		const body = await send(db, listCommand({ permissions: SERVER_MANAGER_PERMISSIONS }, true));

		const options = rows(body)[0]?.[0]?.options ?? [];
		const lines = (body.data?.content ?? '').split('\n').filter((line) => line.startsWith('- '));
		expect(options.length).toBeLessThanOrEqual(25);
		expect(options.length).toBe(lines.length);
		for (const option of options) {
			expect(option.label.length).toBeLessThanOrEqual(100);
		}
	});

	it('リマインダがなければ選択メニューを付けない', async () => {
		const body = await send(createTestDb(), listCommand());
		expect(body.data?.content).toBe('登録しているリマインダはありません。');
		expect(body.data?.components ?? []).toEqual([]);
	});
});

describe('リマインダの選択', () => {
	it('有効なリマインダは要約と [一時停止] を表示する', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const body = await send(db, select(reminder.id));

		expect(body.type).toBe(7);
		expect(body.data?.content).toContain(`📌 リマインダ #${reminder.id}`);
		expect(body.data?.content).toContain('- 予定: 毎週 月水金 09:00');
		expect(customIds(body)).toEqual([
			[
				`${MANAGE_EDIT_BUTTON_ID};${reminder.id}`,
				`${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:pause`,
				`${MANAGE_DELETE_BUTTON_ID};${reminder.id}`,
			],
			[`${NOTIFY_SETTINGS_BUTTON_ID};${reminder.id}`, `${PERIOD_SETTINGS_BUTTON_ID};${reminder.id}`],
		]);
		expect(rows(body)[0]?.map((component) => component.label)).toEqual(['基本設定を編集', '一時停止', '削除']);
	});

	it('一時停止中・エラーのリマインダは [再開] を表示する', async () => {
		const db = createTestDb();
		const paused = await seed(db);
		await updateReminder(db, paused.id, { status: 'paused', next_run_at: null }, NOW);
		const failed = await seed(db, { schedule_type: 'once', once_at: NOW + 3600_000, weekdays_mask: null });
		await updateReminder(db, failed.id, { status: 'error', last_error: '投稿できません' }, NOW);

		for (const id of [paused.id, failed.id]) {
			const body = await send(db, select(id));
			expect(rows(body)[0]?.map((component) => component.label)).toEqual(['基本設定を編集', '再開', '削除']);
			expect(rows(body)[0]?.[1]?.custom_id).toBe(`${MANAGE_TOGGLE_BUTTON_ID};${id}:resume`);
		}
		// 1回のみは [期間・祝日] を出さない
		const body = await send(db, select(failed.id));
		expect(customIds(body)[1]).toEqual([`${NOTIFY_SETTINGS_BUTTON_ID};${failed.id}`]);
	});

	it('他の人のリマインダは、サーバーの管理権限があれば選べる', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { owner_id: OTHER_USER_ID });

		const denied = await send(db, select(reminder.id));
		expect(denied.type).toBe(4);
		expect(denied.data?.flags).toBe(EPHEMERAL);
		expect(denied.data?.content).toBe(`リマインダ #${reminder.id} が見つかりません。`);

		const allowed = await send(db, select(reminder.id, { permissions: SERVER_MANAGER_PERMISSIONS }));
		expect(allowed.type).toBe(7);
	});

	it('別のサーバーのリマインダは選べない', async () => {
		const db = createTestDb();
		const reminder = await seed(db, { guild_id: OTHER_GUILD_ID });
		const body = await send(db, select(reminder.id, { permissions: SERVER_MANAGER_PERMISSIONS }));
		expect(body.type).toBe(4);
		expect(body.data?.content).toBe(`リマインダ #${reminder.id} が見つかりません。`);
	});
});

describe('[基本設定を編集]', () => {
	it('現在の種類を選択済みにした繰り返しの選択メニューを表示する', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const body = await send(db, button(`${MANAGE_EDIT_BUTTON_ID};${reminder.id}`));

		expect(body.type).toBe(7);
		expect(body.data?.content).toContain('繰り返しを選んでください');
		const [[menu]] = rows(body);
		expect(menu?.custom_id).toBe(`${EDIT_REPEAT_SELECT_ID};${reminder.id}`);
		expect(menu?.options?.filter((option) => option.default).map((option) => option.value)).toEqual(['weekly']);
	});

	it('操作できない人・別のサーバーは拒否する', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const other = await seed(db, { guild_id: OTHER_GUILD_ID });

		expect(
			(await send(db, button(`${MANAGE_EDIT_BUTTON_ID};${reminder.id}`, { userId: OTHER_USER_ID }))).type,
		).toBe(4);
		expect((await send(db, button(`${MANAGE_EDIT_BUTTON_ID};${other.id}`))).data?.content).toContain(
			'見つかりません',
		);
	});
});

describe('[一時停止] / [再開]', () => {
	it('一時停止して [再開] に付け替え、再開して [一時停止] に戻す', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const paused = await send(db, button(`${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:pause`));
		expect(paused.type).toBe(7);
		expect(paused.data?.content).toContain(`⏸️ リマインダ #${reminder.id} を一時停止しました`);
		expect(rows(paused)[0]?.[1]).toMatchObject({ label: '再開', style: ButtonStyle.Success });
		expect((await getReminder(db, reminder.id))?.status).toBe('paused');

		const resumed = await send(db, button(`${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:resume`));
		expect(resumed.type).toBe(7);
		expect(resumed.data?.content).toContain(`▶️ リマインダ #${reminder.id} を再開しました`);
		expect(rows(resumed)[0]?.[1]?.label).toBe('一時停止');
		expect((await getReminder(db, reminder.id))?.status).toBe('active');
	});

	it('状態が変わっていれば、既存のコマンドと同じメッセージを返す', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const body = await send(db, button(`${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:resume`));
		expect(body.data?.content).toContain('再開できません');
		expect(rows(body)[0]?.[1]?.label).toBe('一時停止');
	});

	it('再開には通知先へ投稿する権限が必要', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		await updateReminder(db, reminder.id, { status: 'paused', next_run_at: null }, NOW);
		const body = await send(
			db,
			button(`${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:resume`, { permissions: String(1n << 10n) }),
		);
		expect(body.data?.content).toContain('投稿する権限');
		expect((await getReminder(db, reminder.id))?.status).toBe('paused');
	});

	it('操作できない人・別のサーバー・不正な値は拒否する', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const other = await seed(db, { guild_id: OTHER_GUILD_ID });

		const denied = await send(
			db,
			button(`${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:pause`, { userId: OTHER_USER_ID }),
		);
		expect(denied.type).toBe(4);
		expect(denied.data?.content).toContain('見つかりません');
		const foreign = await send(
			db,
			button(`${MANAGE_TOGGLE_BUTTON_ID};${other.id}:pause`, { permissions: SERVER_MANAGER_PERMISSIONS }),
		);
		expect(foreign.data?.content).toContain('見つかりません');
		expect((await send(db, button(`${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:stop`))).data?.content).toBe(
			'この操作は無効です。',
		);
		expect((await getReminder(db, reminder.id))?.status).toBe('active');
		expect((await getReminder(db, other.id))?.status).toBe('active');
	});
});

describe('[削除]', () => {
	it('確認を表示し、キャンセルで元の表示に戻る', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const confirm = await send(db, button(`${MANAGE_DELETE_BUTTON_ID};${reminder.id}`));
		expect(confirm.type).toBe(7);
		expect(confirm.data?.content).toContain(`リマインダ #${reminder.id} を削除しますか？`);
		expect(rows(confirm)[0]).toMatchObject([
			{
				label: '削除する',
				style: ButtonStyle.Danger,
				custom_id: `${MANAGE_DELETE_CONFIRM_BUTTON_ID};${reminder.id}`,
			},
			{ label: 'キャンセル', custom_id: `${MANAGE_DELETE_CANCEL_BUTTON_ID};${reminder.id}` },
		]);

		const cancelled = await send(db, button(`${MANAGE_DELETE_CANCEL_BUTTON_ID};${reminder.id}`));
		expect(cancelled.type).toBe(7);
		expect(cancelled.data?.content).toContain(`📌 リマインダ #${reminder.id}`);
		expect(rows(cancelled)[0]?.map((component) => component.label)).toEqual(['基本設定を編集', '一時停止', '削除']);
		expect(await getReminder(db, reminder.id)).not.toBeNull();
	});

	it('[削除する] で削除する', async () => {
		const db = createTestDb();
		const reminder = await seed(db);

		const body = await send(db, button(`${MANAGE_DELETE_CONFIRM_BUTTON_ID};${reminder.id}`));

		expect(body.type).toBe(7);
		expect(body.data?.content).toBe(`🗑️ リマインダ #${reminder.id} を削除しました。`);
		expect(body.data?.components).toEqual([]);
		expect(await getReminder(db, reminder.id)).toBeNull();
	});

	it('開いている通知があれば、ボタンを外してから結果を表示する', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const occurrenceId = await insertOccurrence(db, reminder.id, NOW, reminder.channel_id);
		await updateOccurrence(db, occurrenceId, { last_message_id: 'msg-1' });
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));

		const body = await send(db, button(`${MANAGE_DELETE_CONFIRM_BUTTON_ID};${reminder.id}`));

		expect(body.type).toBe(6);
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
				body: {
					content: `🗑️ リマインダ #${reminder.id} を削除しました。`,
					components: [],
					allowed_mentions: { parse: [] },
				},
			},
		]);
		expect(await getReminder(db, reminder.id)).toBeNull();
	});

	it('操作できない人・別のサーバーは削除できない', async () => {
		const db = createTestDb();
		const reminder = await seed(db);
		const other = await seed(db, { guild_id: OTHER_GUILD_ID });

		for (const id of [MANAGE_DELETE_BUTTON_ID, MANAGE_DELETE_CONFIRM_BUTTON_ID, MANAGE_DELETE_CANCEL_BUTTON_ID]) {
			const denied = await send(db, button(`${id};${reminder.id}`, { userId: OTHER_USER_ID }));
			expect(denied.type).toBe(4);
			expect(denied.data?.flags).toBe(EPHEMERAL);
			expect(denied.data?.content).toContain('見つかりません');
			const foreign = await send(db, button(`${id};${other.id}`, { permissions: SERVER_MANAGER_PERMISSIONS }));
			expect(foreign.data?.content).toContain('見つかりません');
		}
		expect(await getReminder(db, reminder.id)).not.toBeNull();
		expect(await getReminder(db, other.id)).not.toBeNull();
	});
});
