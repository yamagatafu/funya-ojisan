import { type APIModalInteractionResponseCallbackData, ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { makeActionRow, makeButton, makeModal, makeTextInput, textInputStyle } from 'discord-hono';
import { factory } from '../factory.ts';
import { formatJstTime, MINUTE_MS } from '../reminder/date.ts';
import { DONE_BUTTON_ID, SNOOZE_BUTTON_ID, SNOOZE_CUSTOM_BUTTON_ID, withStatusLine } from '../reminder/message.ts';
import { canOperateOccurrence } from '../reminder/permissions.ts';
import {
	cancelPendingJobs,
	closeOccurrence,
	getOccurrence,
	getReminder,
	insertJob,
	type OccurrenceRow,
	type ReminderRow,
} from '../reminder/repository.ts';
import type { ReminderDb } from '../types.ts';

export const SNOOZE_MODAL_ID = 'remind_snooze_modal';
const SNOOZE_MINUTES_INPUT_ID = 'minutes';
const SNOOZE_MODAL_TITLE = 'スヌーズ時間を指定';
const SNOOZE_MINUTES_LABEL = '何分後に再通知しますか（1〜1440）';
export const MIN_SNOOZE_MINUTES = 1;
export const MAX_SNOOZE_MINUTES = 1440;

const MESSAGES = {
	invalid: 'このボタンは無効です。',
	deleted: 'このリマインダは削除されています。',
	closed: 'この通知はすでに完了または終了しています。',
	forbidden: 'この通知を操作できるのは、登録者・メンション対象のメンバー・メッセージの管理権限を持つ人だけです。',
	invalidMinutes: `${MIN_SNOOZE_MINUTES}〜${MAX_SNOOZE_MINUTES} の整数で入力してください。`,
	notConfigured: 'リマインダ機能が設定されていません。管理者に連絡してください。',
} as const;

/** 完了・スヌーズで取り消すジョブの種類 */
const CANCELLED_KINDS_ON_ACTION = ['nag', 'snooze'] as const;

interface InteractionLike {
	member?: { user: { id: string }; roles: string[]; permissions: string };
	message?: { content: string };
}

type TargetResult =
	| { ok: true; occurrence: OccurrenceRow; reminder: ReminderRow; userId: string }
	| { ok: false; message: string };

/** 正の整数の ID を解釈する。不正なら null */
function parseId(value: string | undefined): number | null {
	if (!value || !/^\d{1,15}$/.test(value)) {
		return null;
	}
	const id = Number(value);
	return id > 0 ? id : null;
}

/** スヌーズ時間 (分) を解釈する。全角数字も受け付ける。範囲外・不正なら null */
export function parseSnoozeMinutes(value: string | undefined): number | null {
	const normalized = value?.normalize('NFKC').trim();
	if (!normalized || !/^\d{1,4}$/.test(normalized)) {
		return null;
	}
	const minutes = Number(normalized);
	return minutes >= MIN_SNOOZE_MINUTES && minutes <= MAX_SNOOZE_MINUTES ? minutes : null;
}

/** 共通の確認: 回・リマインダの存在、open であること、操作できる人であること */
async function loadTarget(
	db: ReminderDb | undefined,
	interaction: InteractionLike,
	occurrenceId: number | null,
): Promise<TargetResult> {
	if (!db) {
		return { ok: false, message: MESSAGES.notConfigured };
	}
	if (occurrenceId === null) {
		return { ok: false, message: MESSAGES.invalid };
	}
	const member = interaction.member;
	if (!member) {
		return { ok: false, message: MESSAGES.forbidden };
	}
	const occurrence = await getOccurrence(db, occurrenceId);
	const reminder = occurrence ? await getReminder(db, occurrence.reminder_id) : null;
	if (!occurrence || !reminder) {
		return { ok: false, message: MESSAGES.deleted };
	}
	if (occurrence.state !== 'open') {
		return { ok: false, message: MESSAGES.closed };
	}
	const userId = member.user.id;
	if (!canOperateOccurrence(reminder, { userId, roles: member.roles, permissions: member.permissions })) {
		return { ok: false, message: MESSAGES.forbidden };
	}
	return { ok: true, occurrence, reminder, userId };
}

/** その回の未送信の再通知・スヌーズを取り消し、新しいスヌーズを登録する。再通知の時刻を返す */
async function snooze(
	db: ReminderDb,
	target: { occurrence: OccurrenceRow; reminder: ReminderRow },
	minutes: number,
	now: number,
): Promise<number> {
	const runAt = now + minutes * MINUTE_MS;
	await cancelPendingJobs(
		db,
		{ reminderId: target.reminder.id, occurrenceId: target.occurrence.id, kinds: [...CANCELLED_KINDS_ON_ACTION] },
		now,
	);
	await insertJob(
		db,
		{
			reminderId: target.reminder.id,
			occurrenceId: target.occurrence.id,
			kind: 'snooze',
			runAt,
			scheduledAt: target.occurrence.scheduled_at,
		},
		now,
	);
	return runAt;
}

function snoozedContent(interaction: InteractionLike, userId: string, runAt: number): string {
	return withStatusLine(
		interaction.message?.content ?? '',
		`⏰ <@${userId}> が ${formatJstTime(runAt)} に再通知を予約しました`,
	);
}

/** 1 回分のスヌーズ時間指定モーダル (共有の builder を書き換えないよう毎回新しく作る) */
function buildSnoozeModal(occurrenceId: number): APIModalInteractionResponseCallbackData {
	return {
		custom_id: `${SNOOZE_MODAL_ID};${occurrenceId}`,
		title: SNOOZE_MODAL_TITLE,
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.TextInput,
						custom_id: SNOOZE_MINUTES_INPUT_ID,
						label: SNOOZE_MINUTES_LABEL,
						style: TextInputStyle.Short,
						required: true,
						min_length: 1,
						max_length: 4,
						placeholder: '例: 10',
					},
				],
			},
		],
	};
}

/** ✅ 完了 */
export const reminderDoneComponent = factory.component(makeButton(DONE_BUTTON_ID, '完了'), async (c) => {
	const db = c.env.REMINDER_DB;
	const target = await loadTarget(db, c.interaction, parseId(c.ref.custom_value));
	if (!target.ok) {
		return c.flags('EPHEMERAL').res(target.message);
	}
	const now = Date.now();
	// 先に未送信の再通知・スヌーズを取り消してから完了にする。
	// 取り消しで失敗した場合は回が open のまま残るため、再度押せば最後まで完了できる
	await cancelPendingJobs(
		db,
		{ reminderId: target.reminder.id, occurrenceId: target.occurrence.id, kinds: [...CANCELLED_KINDS_ON_ACTION] },
		now,
	);
	if (!(await closeOccurrence(db, target.occurrence.id, 'completed', { by: target.userId, now }))) {
		return c.flags('EPHEMERAL').res(MESSAGES.closed);
	}
	return c.update().res({
		content: withStatusLine(
			c.interaction.message?.content ?? '',
			`✅ <@${target.userId}> が完了しました（${formatJstTime(now)}）`,
		),
		components: [],
		allowed_mentions: { parse: [] },
	});
});

/** ⏰ 5分 / 15分 / 30分 (custom_value は `{occurrenceId}:{minutes}`) */
export const reminderSnoozeComponent = factory.component(makeButton(SNOOZE_BUTTON_ID, 'スヌーズ'), async (c) => {
	const db = c.env.REMINDER_DB;
	const match = /^(\d+):(\d+)$/.exec(c.ref.custom_value ?? '');
	const minutes = parseSnoozeMinutes(match?.[2]);
	const occurrenceId = minutes === null ? null : parseId(match?.[1]);
	const target = await loadTarget(db, c.interaction, occurrenceId);
	if (!target.ok || minutes === null) {
		return c.flags('EPHEMERAL').res(target.ok ? MESSAGES.invalid : target.message);
	}
	const runAt = await snooze(db, target, minutes, Date.now());
	// components を省略するとボタンはそのまま残る
	return c.update().res({
		content: snoozedContent(c.interaction, target.userId, runAt),
		allowed_mentions: { parse: [] },
	});
});

/** ⏰ 指定… (モーダルを開く) */
export const reminderSnoozeCustomComponent = factory.component(
	makeButton(SNOOZE_CUSTOM_BUTTON_ID, '指定…'),
	async (c) => {
		const target = await loadTarget(c.env.REMINDER_DB, c.interaction, parseId(c.ref.custom_value));
		if (!target.ok) {
			return c.flags('EPHEMERAL').res(target.message);
		}
		return c.resModal(buildSnoozeModal(target.occurrence.id));
	},
);

/** スヌーズ時間指定モーダルの送信 */
export const reminderSnoozeModal = factory.modal(
	makeModal(SNOOZE_MODAL_ID, SNOOZE_MODAL_TITLE, [
		makeActionRow([
			makeTextInput(SNOOZE_MINUTES_INPUT_ID, SNOOZE_MINUTES_LABEL, textInputStyle.Short).required(true),
		]),
	]),
	async (c) => {
		const db = c.env.REMINDER_DB;
		const minutes = parseSnoozeMinutes(c.var[SNOOZE_MINUTES_INPUT_ID]);
		if (minutes === null) {
			return c.flags('EPHEMERAL').res(MESSAGES.invalidMinutes);
		}
		// モーダルを開いてから送信するまでに状態が変わっている可能性があるため、もう一度確認する
		const target = await loadTarget(db, c.interaction, parseId(c.ref.custom_value));
		if (!target.ok) {
			return c.flags('EPHEMERAL').res(target.message);
		}
		const runAt = await snooze(db, target, minutes, Date.now());
		return c.update().res({
			content: snoozedContent(c.interaction, target.userId, runAt),
			allowed_mentions: { parse: [] },
		});
	},
);

export const reminderActionHandlers = [
	reminderDoneComponent,
	reminderSnoozeComponent,
	reminderSnoozeCustomComponent,
	reminderSnoozeModal,
];
