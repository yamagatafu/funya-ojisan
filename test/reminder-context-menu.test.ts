import {
	ApplicationCommandType,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reminderContextMenuHandlers } from '../src/handlers/reminder-context-menu.ts';
import { jstToUtcMs } from '../src/reminder/date.ts';
import { insertReminder, type JobRow, type ReminderInput, type ReminderRow } from '../src/reminder/repository.ts';
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
	USER_ID,
} from './helpers/interaction.ts';

const MESSAGE_ID = '500000000000000000';
/** 2026-11-25 10:00 JST */
const NOW = jstToUtcMs('2026-11-25', 10 * 60);
/** VIEW_CHANNEL のみ (送信権限なし) */
const VIEW_ONLY_PERMISSIONS = String(1n << 10n);

type TestDb = ReturnType<typeof createTestDb>;

function messageCommandInteraction(content: string) {
	return {
		...baseInteractionFields({}),
		type: InteractionType.ApplicationCommand,
		data: {
			id: '600000000000000000',
			name: 'このメッセージをリマインド',
			type: ApplicationCommandType.Message,
			target_id: MESSAGE_ID,
			resolved: {
				messages: {
					[MESSAGE_ID]: {
						id: MESSAGE_ID,
						channel_id: CHANNEL_ID,
						content,
						author: { id: '700000000000000000', username: 'author', discriminator: '0', avatar: null },
					},
				},
			},
		},
	};
}

function modalSubmitInteraction(params: { when: string; memo?: string; permissions?: string; guild?: boolean }) {
	const base = baseInteractionFields({ member: createMember({ permissions: params.permissions }) });
	const interaction: Record<string, unknown> = {
		...base,
		type: InteractionType.ModalSubmit,
		data: {
			custom_id: `remind_message_modal;${MESSAGE_ID}`,
			components: [
				{
					type: ComponentType.ActionRow,
					components: [{ type: ComponentType.TextInput, custom_id: 'when', value: params.when }],
				},
				{
					type: ComponentType.ActionRow,
					components: [{ type: ComponentType.TextInput, custom_id: 'memo', value: params.memo ?? '' }],
				},
			],
		},
	};
	if (params.guild === false) {
		delete interaction.guild_id;
		delete interaction.guild_locale;
		delete interaction.member;
		interaction.user = createMember({}).user;
		interaction.channel = { id: CHANNEL_ID, type: 1 };
	}
	return interaction;
}

async function send(db: TestDb, interaction: Record<string, unknown>) {
	const app = createApp(reminderContextMenuHandlers);
	const { ctx } = createExecutionContext();
	const res = await app.fetch(createInteractionRequest(interaction), createEnv(db), ctx);
	expect(res.status).toBe(200);
	return (await res.json()) as { type: number; data: Record<string, unknown> & { content?: string; flags?: number } };
}

function reminders(db: TestDb): ReminderRow[] {
	return db.raw.prepare('SELECT * FROM reminders ORDER BY id').all() as unknown as ReminderRow[];
}

function jobs(db: TestDb): JobRow[] {
	return db.raw.prepare('SELECT * FROM reminder_jobs ORDER BY id').all() as unknown as JobRow[];
}

describe('メッセージコンテキストメニュー「このメッセージをリマインド」', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('元メッセージの本文をメモに入れたモーダルを開く', async () => {
		const db = createTestDb();
		const body = await send(db, messageCommandInteraction(`  ${'あ'.repeat(300)}  `));
		expect(body.type).toBe(InteractionResponseType.Modal);
		expect(body.data.custom_id).toBe(`remind_message_modal;${MESSAGE_ID}`);
		expect(body.data.title).toBe('このメッセージをリマインド');
		const rows = body.data.components as { components: Record<string, unknown>[] }[];
		const when = rows[0]!.components[0]!;
		const memo = rows[1]!.components[0]!;
		expect(when).toMatchObject({ custom_id: 'when', label: 'いつ通知しますか', required: true, style: 1 });
		expect(memo).toMatchObject({ custom_id: 'memo', label: 'メモ', required: false, style: 2, max_length: 1500 });
		const value = memo.value as string;
		expect(Array.from(value)).toHaveLength(200);
		expect(value.endsWith('…')).toBe(true);
	});

	it('本文が空のメッセージではメモの初期値を省略する', async () => {
		const db = createTestDb();
		const body = await send(db, messageCommandInteraction(''));
		const rows = body.data.components as { components: Record<string, unknown>[] }[];
		expect(rows[1]!.components[0]).not.toHaveProperty('value');
	});

	it('送信すると元メッセージへのリンク付きで 1 回だけのリマインダを登録する', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const db = createTestDb();
		const body = await send(db, modalSubmitInteraction({ when: '30分', memo: '  資料を確認する  ' }));

		expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toContain('✅ リマインダ #1 を登録しました');
		expect(body.data.content).toContain('資料を確認する');

		const [reminder] = reminders(db);
		const runAt = NOW + 30 * 60 * 1000;
		expect(reminder).toMatchObject({
			guild_id: GUILD_ID,
			channel_id: CHANNEL_ID,
			owner_id: USER_ID,
			content: '資料を確認する',
			source_message_url: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`,
			mention_type: 'self',
			mention_target_id: null,
			schedule_type: 'once',
			once_at: runAt,
			time_of_day: 10 * 60 + 30,
			holiday_policy: 'notify',
			status: 'active',
			next_run_at: runAt,
		});
		expect(jobs(db)).toEqual([
			expect.objectContaining({ reminder_id: reminder!.id, kind: 'main', status: 'pending', run_at: runAt }),
		]);
	});

	it('時刻指定 (HH:MM) は JST で解釈する', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const db = createTestDb();
		await send(db, modalSubmitInteraction({ when: '18:00', memo: 'x' }));
		const [reminder] = reminders(db);
		expect(reminder).toMatchObject({ once_at: jstToUtcMs('2026-11-25', 18 * 60), time_of_day: 18 * 60 });
	});

	it('メモが空なら既定の本文にする', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const db = createTestDb();
		await send(db, modalSubmitInteraction({ when: '1時間', memo: '   ' }));
		expect(reminders(db)[0]!.content).toBe('メッセージのリマインド');
	});

	it.each([
		['読み取れない形式', 'そのうち', '読み取れませんでした'],
		['過去の日時', '2026-11-24 09:00', '過去の日時'],
		['365 日より先', '2027-12-01 09:00', '365 日より先'],
	])('「いつ」が%sならエラーを返す', async (_label, when, expected) => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const db = createTestDb();
		const body = await send(db, modalSubmitInteraction({ when, memo: 'x' }));
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toContain(expected);
		expect(body.data.content).toContain('`30分`');
		expect(reminders(db)).toHaveLength(0);
	});

	it('チャンネルへの投稿権限がなければ登録しない', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const db = createTestDb();
		const body = await send(db, modalSubmitInteraction({ when: '30分', permissions: VIEW_ONLY_PERMISSIONS }));
		expect(body.data.content).toContain('投稿する権限がない');
		expect(reminders(db)).toHaveLength(0);
	});

	it('件数の上限に達していれば登録しない', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const db = createTestDb();
		const input: ReminderInput = {
			guild_id: GUILD_ID,
			channel_id: CHANNEL_ID,
			owner_id: USER_ID,
			content: '既存',
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
		};
		for (let i = 0; i < 25; i++) {
			await insertReminder(db, input, NOW);
		}
		const body = await send(db, modalSubmitInteraction({ when: '30分', memo: 'x' }));
		expect(body.data.content).toContain('1 人 25 件まで');
		expect(reminders(db)).toHaveLength(25);
	});

	it('サーバー外 (DM) では登録しない', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const db = createTestDb();
		const body = await send(db, modalSubmitInteraction({ when: '30分', memo: 'x', guild: false }));
		expect(body.data.content).toContain('サーバー内でのみ');
		expect(reminders(db)).toHaveLength(0);
	});
});
