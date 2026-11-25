import { ApplicationCommandOptionType, ComponentType, InteractionType } from 'discord-api-types/v10';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { REMINDER_CRON, reminderHandlers } from '../src/handlers/reminder.ts';
import { jstToUtcMs, MINUTE_MS } from '../src/reminder/date.ts';
import type { JobRow, OccurrenceRow } from '../src/reminder/repository.ts';
import { createTestDb } from './helpers/d1.ts';
import {
	baseInteractionFields,
	CHANNEL_ID,
	createApp,
	createEnv,
	createExecutionContext,
	createInteractionRequest,
	createMember,
	USER_ID,
} from './helpers/interaction.ts';

/**
 * 登録 (/remind add) → Cron による通知 → スヌーズ → 再通知 → 完了 までを、
 * 本番と同じハンドラ一覧 (reminderHandlers) を通して確認する。
 */
describe('reminder end-to-end', () => {
	const db = createTestDb();
	const env = createEnv(db);
	const app = createApp(reminderHandlers);
	let messageSeq = 0;
	let fetchMock: MockInstance<typeof fetch>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
			if (init?.method === 'POST') {
				messageSeq++;
				return Response.json({ id: `msg-${messageSeq}` });
			}
			return Response.json({});
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function interact(interaction: Record<string, unknown>) {
		const { ctx, flush } = createExecutionContext();
		const response = await app.fetch(createInteractionRequest(interaction), env, ctx);
		await flush();
		return (await response.json()) as { type: number; data: { content?: string; components?: unknown[] } };
	}

	async function tick(at: number) {
		vi.setSystemTime(at);
		const { ctx, flush } = createExecutionContext();
		await app.scheduled({ cron: REMINDER_CRON, scheduledTime: at, type: 'scheduled' } as never, env, ctx);
		await flush();
	}

	function posts() {
		return fetchMock.mock.calls
			.filter(([, init]) => init?.method === 'POST')
			.map(([, init]) => JSON.parse(String(init?.body)) as { content: string });
	}

	function button(customId: string, content: string) {
		return {
			...baseInteractionFields({ member: createMember({}) }),
			type: InteractionType.MessageComponent,
			message: { id: 'msg', channel_id: CHANNEL_ID, content },
			data: { component_type: ComponentType.Button, custom_id: customId },
		};
	}

	it('runs the whole lifecycle', async () => {
		// 2026-11-25 (水) 08:00 に「平日 09:00・10分前に事前通知・30分おきに最大2回再通知」で登録
		vi.setSystemTime(jstToUtcMs('2026-11-25', 8 * 60));
		const added = await interact({
			...baseInteractionFields({}),
			type: InteractionType.ApplicationCommand,
			data: {
				id: '1',
				name: 'remind',
				type: 1,
				options: [
					{
						name: 'add',
						type: ApplicationCommandOptionType.Subcommand,
						options: [
							{ name: 'content', type: ApplicationCommandOptionType.String, value: '朝会' },
							{ name: 'time', type: ApplicationCommandOptionType.String, value: '09:00' },
							{ name: 'repeat', type: ApplicationCommandOptionType.String, value: 'weekdays' },
							{ name: 'pre_notify', type: ApplicationCommandOptionType.Integer, value: 10 },
							{ name: 'nag_interval', type: ApplicationCommandOptionType.Integer, value: 30 },
							{ name: 'nag_max', type: ApplicationCommandOptionType.Integer, value: 2 },
						],
					},
				],
			},
		});
		expect(added.data.content).toContain('✅ リマインダ #1 を登録しました');

		// 08:50 事前通知 → 09:00 本通知
		await tick(jstToUtcMs('2026-11-25', 8 * 60 + 50));
		await tick(jstToUtcMs('2026-11-25', 9 * 60));
		expect(posts().map((post) => post.content.split('\n')[0])).toEqual([
			`⏳ <@${USER_ID}> 10分後（09:00）にリマインドがあります`,
			`⏰ <@${USER_ID}> リマインド`,
		]);
		const mainContent = posts()[1]!.content;

		// 09:05 に 15分スヌーズ → 09:20 にスヌーズ通知
		vi.setSystemTime(jstToUtcMs('2026-11-25', 9 * 60 + 5));
		const snoozed = await interact(button('remind_snooze;1:15', mainContent));
		expect(snoozed.data.content).toContain(`⏰ <@${USER_ID}> が 09:20 に再通知を予約しました`);
		await tick(jstToUtcMs('2026-11-25', 9 * 60 + 20));
		expect(posts().at(-1)?.content).toContain('スヌーズしたリマインド');

		// スヌーズ通知から 30 分後に再通知 (1/2)
		await tick(jstToUtcMs('2026-11-25', 9 * 60 + 50));
		expect(posts().at(-1)?.content).toContain('再通知 (1/2)');

		// 完了すると以降の再通知は止まる
		vi.setSystemTime(jstToUtcMs('2026-11-25', 9 * 60 + 55));
		const done = await interact(button('remind_done;1', posts().at(-1)!.content));
		expect(done.data.content).toContain(`✅ <@${USER_ID}> が完了しました（09:55）`);
		expect(done.data.components).toEqual([]);

		const postCount = posts().length;
		await tick(jstToUtcMs('2026-11-25', 10 * 60 + 20));
		expect(posts()).toHaveLength(postCount);

		const occurrence = db.raw.prepare('SELECT * FROM reminder_occurrences WHERE id = 1').get() as OccurrenceRow;
		expect(occurrence).toMatchObject({ state: 'completed', completed_by: USER_ID, nag_count: 1 });

		// 翌日分の事前通知・本通知が予約されている
		const pending = db.raw
			.prepare("SELECT * FROM reminder_jobs WHERE status = 'pending' ORDER BY run_at")
			.all() as JobRow[];
		expect(pending.map((job) => [job.kind, job.run_at])).toEqual([
			['pre', jstToUtcMs('2026-11-26', 9 * 60) - 10 * MINUTE_MS],
			['main', jstToUtcMs('2026-11-26', 9 * 60)],
		]);
	});
});
