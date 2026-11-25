import { ComponentType, InteractionType } from 'discord-api-types/v10';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderActionHandlers } from '../src/handlers/reminder-actions.ts';
import { jstToUtcMs, MINUTE_MS } from '../src/reminder/date.ts';
import { buildActionButtons } from '../src/reminder/message.ts';
import {
	closeOccurrence,
	deleteReminder,
	getOccurrence,
	insertJob,
	insertOccurrence,
	insertReminder,
	type JobRow,
	type ReminderInput,
} from '../src/reminder/repository.ts';
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
	MODERATOR_PERMISSIONS,
	USER_ID,
} from './helpers/interaction.ts';

const OWNER_ID = USER_ID;
const OTHER_ID = '300000000000000099';
const TARGET_USER_ID = '300000000000000042';
const ROLE_ID = '500000000000000000';
const SCHEDULED_AT = jstToUtcMs('2026-11-25', 9 * 60);
const NOW = jstToUtcMs('2026-11-25', 9 * 60 + 3);
const MESSAGE_CONTENT = `⏰ <@${OWNER_ID}> リマインド\nゴミ出し\n-# #1 · <@${OWNER_ID}> · 毎日 09:00`;
const EPHEMERAL = 64;

function reminderInput(overrides: Partial<ReminderInput> = {}): ReminderInput {
	return {
		guild_id: GUILD_ID,
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
		nag_interval_minutes: 10,
		nag_max_count: 3,
		end_date: null,
		remaining_count: null,
		...overrides,
	};
}

/** リマインダ・送信済みの回・未送信の再通知ジョブ・次回の本通知ジョブを用意する */
async function setup(overrides: Partial<ReminderInput> = {}) {
	const db = createTestDb();
	const reminderId = await insertReminder(db, reminderInput(overrides), SCHEDULED_AT - 60 * MINUTE_MS);
	const occurrenceId = await insertOccurrence(db, reminderId, SCHEDULED_AT, CHANNEL_ID);
	const nagJobId = await insertJob(
		db,
		{ reminderId, occurrenceId, kind: 'nag', runAt: SCHEDULED_AT + 10 * MINUTE_MS, scheduledAt: SCHEDULED_AT },
		SCHEDULED_AT,
	);
	const nextMainJobId = await insertJob(
		db,
		{
			reminderId,
			occurrenceId: null,
			kind: 'main',
			runAt: SCHEDULED_AT + 24 * 60 * MINUTE_MS,
			scheduledAt: SCHEDULED_AT + 24 * 60 * MINUTE_MS,
		},
		SCHEDULED_AT,
	);
	return { db, reminderId, occurrenceId, nagJobId, nextMainJobId };
}

function jobs(db: ReturnType<typeof createTestDb>): JobRow[] {
	return db.raw.prepare('SELECT * FROM reminder_jobs ORDER BY id').all() as JobRow[];
}

function notificationMessage(occurrenceId: number, content = MESSAGE_CONTENT) {
	return {
		id: 'msg-1',
		channel_id: CHANNEL_ID,
		author: { id: 'bot', username: 'bot', discriminator: '0000', avatar: null, global_name: null },
		content,
		timestamp: '2026-11-25T00:00:00.000Z',
		edited_timestamp: null,
		tts: false,
		mention_everyone: false,
		mentions: [],
		mention_roles: [],
		attachments: [],
		embeds: [],
		pinned: false,
		type: 0,
		components: buildActionButtons(occurrenceId),
	};
}

interface ActorParams {
	userId?: string;
	roles?: string[];
	permissions?: string;
}

function buttonInteraction(customId: string, occurrenceId: number, actor: ActorParams = {}) {
	return {
		...baseInteractionFields({ member: createMember(actor) }),
		type: InteractionType.MessageComponent,
		message: notificationMessage(occurrenceId),
		data: { component_type: ComponentType.Button, custom_id: customId },
	};
}

function modalInteraction(occurrenceId: number | string, value: string, actor: ActorParams = {}) {
	return {
		...baseInteractionFields({ member: createMember(actor) }),
		type: InteractionType.ModalSubmit,
		message: notificationMessage(Number(occurrenceId)),
		data: {
			custom_id: `remind_snooze_modal;${occurrenceId}`,
			components: [
				{
					type: ComponentType.ActionRow,
					components: [{ type: ComponentType.TextInput, custom_id: 'minutes', value }],
				},
			],
		},
	};
}

async function send(db: ReturnType<typeof createTestDb>, interaction: Record<string, unknown>) {
	const app = createApp(reminderActionHandlers);
	const { ctx } = createExecutionContext();
	const response = await app.fetch(createInteractionRequest(interaction), createEnv(db), ctx);
	expect(response.status).toBe(200);
	return (await response.json()) as { type: number; data: Record<string, unknown> & { content?: string } };
}

function expectEphemeral(body: Awaited<ReturnType<typeof send>>, content: string | RegExp) {
	expect(body.type).toBe(4);
	expect(body.data.flags).toBe(EPHEMERAL);
	if (typeof content === 'string') {
		expect(body.data.content).toBe(content);
	} else {
		expect(body.data.content).toMatch(content);
	}
}

describe('reminder action buttons', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('完了', () => {
		it('completes the occurrence, cancels nag/snooze jobs and removes the buttons', async () => {
			const { db, reminderId, occurrenceId, nagJobId, nextMainJobId } = await setup();
			const snoozeJobId = await insertJob(
				db,
				{ reminderId, occurrenceId, kind: 'snooze', runAt: NOW + 5 * MINUTE_MS, scheduledAt: SCHEDULED_AT },
				NOW,
			);

			const body = await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId));

			expect(body.type).toBe(7);
			expect(body.data).toEqual({
				content: `${MESSAGE_CONTENT}\n-# ✅ <@${OWNER_ID}> が完了しました（09:03）`,
				components: [],
				allowed_mentions: { parse: [] },
			});
			expect(await getOccurrence(db, occurrenceId)).toMatchObject({
				state: 'completed',
				completed_by: OWNER_ID,
				completed_at: NOW,
			});
			const statuses = new Map(jobs(db).map((job) => [job.id, job.status]));
			expect(statuses.get(nagJobId)).toBe('cancelled');
			expect(statuses.get(snoozeJobId)).toBe('cancelled');
			expect(statuses.get(nextMainJobId)).toBe('pending');
		});

		it('replaces an existing status line', async () => {
			const { db, occurrenceId } = await setup();
			const interaction = buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId);
			interaction.message.content = `${MESSAGE_CONTENT}\n-# ⏰ <@${OWNER_ID}> が 09:05 に再通知を予約しました`;

			const body = await send(db, interaction);

			expect(body.data.content).toBe(`${MESSAGE_CONTENT}\n-# ✅ <@${OWNER_ID}> が完了しました（09:03）`);
		});

		it('keeps body lines that look like status lines', async () => {
			const { db, occurrenceId } = await setup();
			const body = `⏰ <@${OWNER_ID}> リマインド\n-# ✅ 確認済み\n-# ⏰ 09:00 集合\n-# #1 · <@${OWNER_ID}> · 毎日 09:00`;
			const interaction = buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId);
			interaction.message.content = `${body}\n-# ⏰ <@${OWNER_ID}> が 09:05 に再通知を予約しました`;

			const response = await send(db, interaction);

			expect(response.data.content).toBe(`${body}\n-# ✅ <@${OWNER_ID}> が完了しました（09:03）`);
		});

		it('stays open when cancelling jobs fails, so that it can be completed on retry', async () => {
			const { db, occurrenceId, nagJobId } = await setup();
			const originalPrepare = db.prepare.bind(db);
			const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((query: string) => {
				if (query.startsWith("UPDATE reminder_jobs SET status = 'cancelled'")) {
					throw new Error('D1 unavailable');
				}
				return originalPrepare(query);
			});

			await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId)).catch(() => undefined);
			expect((await getOccurrence(db, occurrenceId))?.state).toBe('open');

			prepareSpy.mockRestore();
			const body = await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId));
			expect(body.data.content).toContain('が完了しました');
			expect((await getOccurrence(db, occurrenceId))?.state).toBe('completed');
			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('cancelled');
		});

		it('reports an already completed occurrence', async () => {
			const { db, occurrenceId, nagJobId } = await setup();
			await closeOccurrence(db, occurrenceId, 'completed', { by: OTHER_ID, now: NOW - MINUTE_MS });

			const body = await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId));

			expectEphemeral(body, 'この通知はすでに完了または終了しています。');
			expect(await getOccurrence(db, occurrenceId)).toMatchObject({ completed_by: OTHER_ID });
			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('pending');
		});

		it('reports losing the race when the occurrence is closed after the check', async () => {
			const { db, occurrenceId, nagJobId } = await setup();
			// 状態の確認後、更新までの間に他の処理が完了させた状況を再現する
			const originalPrepare = db.prepare.bind(db);
			vi.spyOn(db, 'prepare').mockImplementation((query: string) => {
				if (query.startsWith('UPDATE reminder_occurrences SET state')) {
					db.raw
						.prepare("UPDATE reminder_occurrences SET state = 'superseded' WHERE id = ?")
						.run(occurrenceId);
				}
				return originalPrepare(query);
			});

			const body = await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId));

			expectEphemeral(body, 'この通知はすでに完了または終了しています。');
			expect(await getOccurrence(db, occurrenceId)).toMatchObject({ state: 'superseded', completed_by: null });
			// 取り消しは完了の判定より先に行う。競合相手 (置き換え・別の完了操作) も同じジョブを取り消すため整合する
			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('cancelled');
		});

		it('reports a deleted reminder', async () => {
			const { db, reminderId, occurrenceId } = await setup();
			await deleteReminder(db, reminderId);

			const body = await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId));

			expectEphemeral(body, 'このリマインダは削除されています。');
		});

		it('rejects a malformed custom_id', async () => {
			const { db } = await setup();

			const body = await send(db, buttonInteraction('remind_done;abc', 1));

			expectEphemeral(body, 'このボタンは無効です。');
		});
	});

	describe('一体性と同時操作', () => {
		/** batch の最後に失敗する文を足し、途中まで実行した文ごとロールバックさせる */
		function failBatchOnce(db: ReturnType<typeof createTestDb>) {
			const batch = db.batch.bind(db);
			return vi
				.spyOn(db, 'batch')
				.mockImplementationOnce((statements) =>
					batch([...statements, db.prepare('INSERT INTO no_such_table VALUES (1)')]),
				);
		}

		it('rolls back both cancellation and completion when the batch fails', async () => {
			const { db, occurrenceId, nagJobId } = await setup();
			const spy = failBatchOnce(db);

			await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId)).catch(() => undefined);

			expect(spy).toHaveBeenCalledTimes(1);
			expect((await getOccurrence(db, occurrenceId))?.state).toBe('open');
			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('pending');

			const body = await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId));
			expect(body.data.content).toContain('が完了しました');
			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('cancelled');
		});

		it('keeps the existing nag when a snooze batch fails', async () => {
			const { db, occurrenceId, nagJobId } = await setup();
			failBatchOnce(db);

			await send(db, buttonInteraction(`remind_snooze;${occurrenceId}:15`, occurrenceId)).catch(() => undefined);

			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('pending');
			expect(jobs(db).filter((job) => job.kind === 'snooze')).toHaveLength(0);
		});

		it('lets the completer repair the message when the previous response was lost', async () => {
			const { db, occurrenceId } = await setup();
			// 完了の batch は反映されたが、応答 (メッセージの更新) が届かなかった状況を再現する
			await closeOccurrence(db, occurrenceId, 'completed', { by: OWNER_ID, now: NOW - MINUTE_MS });

			const body = await send(db, buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId));

			expect(body.type).toBe(7);
			expect(body.data.content).toBe(`${MESSAGE_CONTENT}\n-# ✅ <@${OWNER_ID}> が完了しました（09:02）`);
			expect(body.data.components).toEqual([]);

			// 完了した本人以外は、これまでどおり完了済みとして断る
			const other = await send(
				db,
				buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId, {
					userId: OTHER_ID,
					permissions: MODERATOR_PERMISSIONS,
				}),
			);
			expectEphemeral(other, 'この通知はすでに完了または終了しています。');
		});

		it('does not leave a snooze on an occurrence completed concurrently', async () => {
			const { db, occurrenceId } = await setup();
			const batch = db.batch.bind(db);
			vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
				// 確認後、スヌーズの登録前に別のメンバーが完了させた状況を再現する
				await closeOccurrence(db, occurrenceId, 'completed', { by: OTHER_ID, now: NOW });
				return batch(statements);
			});

			const body = await send(db, buttonInteraction(`remind_snooze;${occurrenceId}:15`, occurrenceId));

			expectEphemeral(body, 'この通知はすでに完了または終了しています。');
			expect(jobs(db).filter((job) => job.kind === 'snooze')).toHaveLength(0);
		});
	});

	describe('権限', () => {
		it('rejects operating a reminder of another guild', async () => {
			const { db, occurrenceId, nagJobId } = await setup({ guild_id: '100000000000000001' });

			for (const customId of [`remind_done;${occurrenceId}`, `remind_snooze;${occurrenceId}:5`]) {
				// 他のサーバーで MANAGE_MESSAGES を持つメンバーが、ID を指定して操作した状況を再現する
				const body = await send(
					db,
					buttonInteraction(customId, occurrenceId, { userId: OTHER_ID, permissions: MODERATOR_PERMISSIONS }),
				);
				expectEphemeral(
					body,
					'この通知を操作できるのは、登録者・メンション対象のメンバー・メッセージの管理権限を持つ人だけです。',
				);
			}
			expect((await getOccurrence(db, occurrenceId))?.state).toBe('open');
			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('pending');
		});

		it('rejects a user who is neither the owner, the mention target nor a moderator', async () => {
			const { db, occurrenceId } = await setup();

			const body = await send(
				db,
				buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId, { userId: OTHER_ID }),
			);

			expectEphemeral(body, /登録者・メンション対象のメンバー・メッセージの管理権限を持つ人だけ/);
			expect(await getOccurrence(db, occurrenceId)).toMatchObject({ state: 'open' });
		});

		it('allows the mentioned user', async () => {
			const { db, occurrenceId } = await setup({ mention_type: 'user', mention_target_id: TARGET_USER_ID });

			const body = await send(
				db,
				buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId, { userId: TARGET_USER_ID }),
			);

			expect(body.type).toBe(7);
			expect(await getOccurrence(db, occurrenceId)).toMatchObject({
				state: 'completed',
				completed_by: TARGET_USER_ID,
			});
		});

		it('allows a member of the mentioned role but not other members', async () => {
			const { db, occurrenceId } = await setup({ mention_type: 'role', mention_target_id: ROLE_ID });

			const rejected = await send(
				db,
				buttonInteraction(`remind_snooze;${occurrenceId}:5`, occurrenceId, {
					userId: OTHER_ID,
					roles: ['999'],
				}),
			);
			expectEphemeral(rejected, /だけです。$/);

			const body = await send(
				db,
				buttonInteraction(`remind_snooze;${occurrenceId}:5`, occurrenceId, {
					userId: OTHER_ID,
					roles: [ROLE_ID],
				}),
			);
			expect(body.type).toBe(7);
			expect(body.data.content).toContain(`⏰ <@${OTHER_ID}> が 09:08 に再通知を予約しました`);
		});

		it('allows a moderator', async () => {
			const { db, occurrenceId } = await setup();

			const body = await send(
				db,
				buttonInteraction(`remind_done;${occurrenceId}`, occurrenceId, {
					userId: OTHER_ID,
					permissions: MODERATOR_PERMISSIONS,
				}),
			);

			expect(body.type).toBe(7);
			expect(body.data.content).toContain(`✅ <@${OTHER_ID}> が完了しました（09:03）`);
		});
	});

	describe('スヌーズ', () => {
		it('cancels the pending nag job and schedules a snooze job', async () => {
			const { db, reminderId, occurrenceId, nagJobId, nextMainJobId } = await setup();

			const body = await send(db, buttonInteraction(`remind_snooze;${occurrenceId}:15`, occurrenceId));

			expect(body.type).toBe(7);
			expect(body.data).toEqual({
				content: `${MESSAGE_CONTENT}\n-# ⏰ <@${OWNER_ID}> が 09:18 に再通知を予約しました`,
				allowed_mentions: { parse: [] },
			});
			const all = jobs(db);
			expect(all.find((job) => job.id === nagJobId)?.status).toBe('cancelled');
			expect(all.find((job) => job.id === nextMainJobId)?.status).toBe('pending');
			expect(all.filter((job) => job.kind === 'snooze')).toMatchObject([
				{
					reminder_id: reminderId,
					occurrence_id: occurrenceId,
					status: 'pending',
					run_at: NOW + 15 * MINUTE_MS,
					scheduled_at: SCHEDULED_AT,
				},
			]);
			expect(await getOccurrence(db, occurrenceId)).toMatchObject({ state: 'open' });
		});

		it('replaces a previous snooze job', async () => {
			const { db, occurrenceId } = await setup();
			await send(db, buttonInteraction(`remind_snooze;${occurrenceId}:5`, occurrenceId));

			await send(db, buttonInteraction(`remind_snooze;${occurrenceId}:30`, occurrenceId));

			expect(
				jobs(db)
					.filter((job) => job.kind === 'snooze')
					.map((job) => [job.status, job.run_at]),
			).toEqual([
				['cancelled', NOW + 5 * MINUTE_MS],
				['pending', NOW + 30 * MINUTE_MS],
			]);
		});

		it.each(['1:0', '1:1441', '1', '1:abc', 'x:5'])('rejects an invalid value %s', async (value) => {
			const { db } = await setup();

			const body = await send(db, buttonInteraction(`remind_snooze;${value}`, 1));

			expectEphemeral(body, 'このボタンは無効です。');
			expect(jobs(db).filter((job) => job.kind === 'snooze')).toEqual([]);
		});

		it('reports a completed occurrence', async () => {
			const { db, occurrenceId } = await setup();
			await closeOccurrence(db, occurrenceId, 'completed', { by: OWNER_ID, now: NOW });

			const body = await send(db, buttonInteraction(`remind_snooze;${occurrenceId}:5`, occurrenceId));

			expectEphemeral(body, 'この通知はすでに完了または終了しています。');
			expect(jobs(db).filter((job) => job.kind === 'snooze')).toEqual([]);
		});
	});

	describe('スヌーズ (指定…)', () => {
		it('opens a modal for the occurrence', async () => {
			const { db, occurrenceId } = await setup();

			const body = await send(db, buttonInteraction(`remind_snooze_custom;${occurrenceId}`, occurrenceId));

			expect(body.type).toBe(9);
			expect(body.data).toMatchObject({
				custom_id: `remind_snooze_modal;${occurrenceId}`,
				title: 'スヌーズ時間を指定',
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.TextInput,
								custom_id: 'minutes',
								label: '何分後に再通知しますか（1〜1440）',
								required: true,
							},
						],
					},
				],
			});
		});

		it('does not open the modal for an unauthorized user', async () => {
			const { db, occurrenceId } = await setup();

			const body = await send(
				db,
				buttonInteraction(`remind_snooze_custom;${occurrenceId}`, occurrenceId, { userId: OTHER_ID }),
			);

			expectEphemeral(body, /だけです。$/);
		});

		it('schedules a snooze job from the modal (full-width digits allowed)', async () => {
			const { db, occurrenceId, nagJobId } = await setup();

			const body = await send(db, modalInteraction(occurrenceId, '１２０'));

			expect(body.type).toBe(7);
			expect(body.data).toEqual({
				content: `${MESSAGE_CONTENT}\n-# ⏰ <@${OWNER_ID}> が 11:03 に再通知を予約しました`,
				allowed_mentions: { parse: [] },
			});
			const all = jobs(db);
			expect(all.find((job) => job.id === nagJobId)?.status).toBe('cancelled');
			expect(all.filter((job) => job.kind === 'snooze')).toMatchObject([
				{
					occurrence_id: occurrenceId,
					status: 'pending',
					run_at: NOW + 120 * MINUTE_MS,
					scheduled_at: SCHEDULED_AT,
				},
			]);
		});

		it.each(['0', '0000', '0999', '1441', '1.5', 'abc', '', '-3'])('rejects invalid input %j', async (value) => {
			const { db, occurrenceId, nagJobId } = await setup();

			const body = await send(db, modalInteraction(occurrenceId, value));

			expectEphemeral(body, '1〜1440 の整数で入力してください。');
			expect(jobs(db).find((job) => job.id === nagJobId)?.status).toBe('pending');
			expect(jobs(db).filter((job) => job.kind === 'snooze')).toEqual([]);
		});

		it('re-checks the occurrence state on submit', async () => {
			const { db, occurrenceId } = await setup();
			await closeOccurrence(db, occurrenceId, 'completed', { by: OWNER_ID, now: NOW });

			const body = await send(db, modalInteraction(occurrenceId, '10'));

			expectEphemeral(body, 'この通知はすでに完了または終了しています。');
			expect(jobs(db).filter((job) => job.kind === 'snooze')).toEqual([]);
		});

		it('re-checks permissions on submit', async () => {
			const { db, occurrenceId } = await setup();

			const body = await send(db, modalInteraction(occurrenceId, '10', { userId: OTHER_ID }));

			expectEphemeral(body, /だけです。$/);
			expect(jobs(db).filter((job) => job.kind === 'snooze')).toEqual([]);
		});

		it('reports a deleted reminder on submit', async () => {
			const { db, reminderId, occurrenceId } = await setup();
			await deleteReminder(db, reminderId);

			const body = await send(db, modalInteraction(occurrenceId, '10'));

			expectEphemeral(body, 'このリマインダは削除されています。');
		});
	});
});
