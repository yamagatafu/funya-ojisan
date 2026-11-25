/**
 * /remind list からの管理 (GUI)。
 * - 一覧の「操作するリマインダ」選択メニュー → 要約と操作ボタン
 * - [基本設定を編集] → 繰り返しの選択メニュー (以降の基本モーダルは別のハンドラが扱う)
 * - [一時停止] / [再開] → 既存の pause / resume と同じ処理
 * - [削除] → 確認 ([削除する] [キャンセル]) → 既存の delete と同じ処理
 *
 * custom_id は改変できるため、どの操作でも findManageableReminder で
 * 「操作したサーバーのリマインダであること」と「操作できる人であること」を確認し直す。
 */
import {
	type APIActionRowComponent,
	type APIButtonComponentWithCustomId,
	type APIComponentInMessageActionRow,
	ButtonStyle,
	ComponentType,
} from 'discord-api-types/v10';
import { makeButton, makeStringSelect } from 'discord-hono';
import { factory } from '../factory.ts';
import {
	buildDetailButtons,
	buildRepeatSelect,
	EDIT_REPEAT_SELECT_ID,
	MANAGE_DELETE_BUTTON_ID,
	MANAGE_DELETE_CANCEL_BUTTON_ID,
	MANAGE_DELETE_CONFIRM_BUTTON_ID,
	MANAGE_EDIT_BUTTON_ID,
	MANAGE_SELECT_ID,
	MANAGE_TOGGLE_BUTTON_ID,
	parseReminderId,
} from '../reminder/gui.ts';
import { buildReminderSummary } from '../reminder/message.ts';
import type { ReminderRow } from '../reminder/repository.ts';
import {
	buildInvocation,
	findManageableReminder,
	handleDelete,
	handlePause,
	handleResume,
	type Invocation,
	type Reply,
	type ReplyMessage,
	replyData,
} from './reminder-commands.ts';

const MESSAGES = {
	notConfigured: 'リマインダの保存先が設定されていません。管理者に連絡してください。',
	guildOnly: 'この操作はサーバー内でのみ使用できます。',
	invalid: 'この操作は無効です。',
	error: 'エラーが発生しました。時間をおいて再度お試しください。',
} as const;

function notFound(id: number): string {
	return `リマインダ #${id} が見つかりません。`;
}

/** [一時停止] / [再開] の操作 (custom_value は `{reminderId}:{action}`) */
type ToggleAction = 'pause' | 'resume';

function parseToggleValue(value: string | undefined): { id: number; action: ToggleAction } | null {
	const [idValue, action] = (value ?? '').split(':');
	const id = parseReminderId(idValue);
	if (id === null || (action !== 'pause' && action !== 'resume')) {
		return null;
	}
	return { id, action };
}

/** 状態に応じた [一時停止] / [再開] ボタン (エラー状態は再開して予定を登録し直す。終了済みは出さない) */
function toggleButton(reminder: Pick<ReminderRow, 'id' | 'status'>): APIButtonComponentWithCustomId | null {
	if (reminder.status === 'active') {
		return {
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: '一時停止',
			emoji: { name: '⏸️' },
			custom_id: `${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:pause`,
		};
	}
	if (reminder.status === 'paused' || reminder.status === 'error') {
		return {
			type: ComponentType.Button,
			style: ButtonStyle.Success,
			label: '再開',
			emoji: { name: '▶️' },
			custom_id: `${MANAGE_TOGGLE_BUTTON_ID};${reminder.id}:resume`,
		};
	}
	return null;
}

/** 管理画面の操作ボタン: [基本設定を編集] [一時停止 / 再開] [削除] と [通知設定] [期間・祝日] */
export function buildManageButtons(reminder: ReminderRow): APIActionRowComponent<APIButtonComponentWithCustomId>[] {
	const toggle = toggleButton(reminder);
	const actions: APIButtonComponentWithCustomId[] = [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Primary,
			label: '基本設定を編集',
			emoji: { name: '✏️' },
			custom_id: `${MANAGE_EDIT_BUTTON_ID};${reminder.id}`,
		},
		...(toggle ? [toggle] : []),
		{
			type: ComponentType.Button,
			style: ButtonStyle.Danger,
			label: '削除',
			emoji: { name: '🗑️' },
			custom_id: `${MANAGE_DELETE_BUTTON_ID};${reminder.id}`,
		},
	];
	return [{ type: ComponentType.ActionRow, components: actions }, buildDetailButtons(reminder)];
}

/** 選んだリマインダの要約と操作ボタン */
function manageView(reminder: ReminderRow, heading = `📌 リマインダ #${reminder.id}`): ReplyMessage {
	return { content: buildReminderSummary(reminder, heading), components: buildManageButtons(reminder) };
}

function deleteConfirmView(reminder: ReminderRow): ReplyMessage {
	const buttons: APIComponentInMessageActionRow[] = [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Danger,
			label: '削除する',
			custom_id: `${MANAGE_DELETE_CONFIRM_BUTTON_ID};${reminder.id}`,
		},
		{
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: 'キャンセル',
			custom_id: `${MANAGE_DELETE_CANCEL_BUTTON_ID};${reminder.id}`,
		},
	];
	return {
		content: buildReminderSummary(reminder, `🗑️ リマインダ #${reminder.id} を削除しますか？`),
		components: [{ type: ComponentType.ActionRow, components: buttons }],
	};
}

/** 共通の準備: DB とサーバー内のインタラクションであることを確認し、対象 ID の Invocation を作る */
type Prepared = { ok: true; inv: Invocation; id: number } | { ok: false; message: string };

type ComponentInteraction = Parameters<typeof buildInvocation>[0]['interaction'];

function prepare(db: Invocation['db'] | undefined, interaction: ComponentInteraction, id: number | null): Prepared {
	if (!db) {
		console.error('REMINDER_DB binding is not configured.');
		return { ok: false, message: MESSAGES.notConfigured };
	}
	if (id === null) {
		return { ok: false, message: MESSAGES.invalid };
	}
	const inv = buildInvocation({ db, interaction, resolved: undefined, opts: { id } });
	return inv ? { ok: true, inv, id } : { ok: false, message: MESSAGES.guildOnly };
}

/** 選択メニューで選ばれた ID */
function selectedId(data: { values?: unknown }): number | null {
	const values = data.values;
	if (!Array.isArray(values)) {
		return null;
	}
	const [value] = values;
	return typeof value === 'string' ? parseReminderId(value) : null;
}

/** 「操作するリマインダ」の選択 → 要約と操作ボタン */
export const manageSelectComponent = factory.component(makeStringSelect(MANAGE_SELECT_ID, []), async (c) => {
	const data = c.interaction.data;
	const prepared = prepare(c.env.REMINDER_DB, c.interaction, selectedId('values' in data ? data : {}));
	if (!prepared.ok) {
		return c.flags('EPHEMERAL').res(replyData(prepared.message));
	}
	const reminder = await findManageableReminder(prepared.inv);
	if (!reminder) {
		return c.flags('EPHEMERAL').res(replyData(notFound(prepared.id)));
	}
	return c.update().res(replyData({ message: manageView(reminder) }));
});

/** [基本設定を編集] → 繰り返しの選択メニュー (既定値は現在の種類) */
export const manageEditComponent = factory.component(makeButton(MANAGE_EDIT_BUTTON_ID, '基本設定を編集'), async (c) => {
	const prepared = prepare(c.env.REMINDER_DB, c.interaction, parseReminderId(c.ref.custom_value));
	if (!prepared.ok) {
		return c.flags('EPHEMERAL').res(replyData(prepared.message));
	}
	const reminder = await findManageableReminder(prepared.inv);
	if (!reminder) {
		return c.flags('EPHEMERAL').res(replyData(notFound(prepared.id)));
	}
	return c.update().res(
		replyData({
			message: {
				content: `✏️ リマインダ #${reminder.id} の繰り返しを選んでください。選ぶと入力画面が開きます。`,
				components: [buildRepeatSelect(`${EDIT_REPEAT_SELECT_ID};${reminder.id}`, reminder.schedule_type)],
			},
		}),
	);
});

/** [一時停止] / [再開] */
export const manageToggleComponent = factory.component(
	makeButton(MANAGE_TOGGLE_BUTTON_ID, '一時停止 / 再開'),
	async (c) => {
		const toggle = parseToggleValue(c.ref.custom_value);
		const prepared = prepare(c.env.REMINDER_DB, c.interaction, toggle?.id ?? null);
		if (!prepared.ok || !toggle) {
			return c.flags('EPHEMERAL').res(replyData(prepared.ok ? MESSAGES.invalid : prepared.message));
		}
		const { inv } = prepared;
		if (!(await findManageableReminder(inv))) {
			return c.flags('EPHEMERAL').res(replyData(notFound(toggle.id)));
		}
		let reply: Reply;
		try {
			reply = toggle.action === 'pause' ? await handlePause(inv) : await handleResume(inv);
		} catch (error) {
			console.error(`Unexpected error in reminder manage ${toggle.action}:`, error);
			return c.flags('EPHEMERAL').res(replyData(MESSAGES.error));
		}
		if (typeof reply !== 'string') {
			// pause / resume は文字列だけを返す (遅延応答・メッセージ形式は想定外)
			return c.flags('EPHEMERAL').res(replyData(MESSAGES.error));
		}
		// 結果の本文に、新しい状態に合わせた操作ボタンを付け直す (権限不足などで失敗した場合も操作を続けられるように)
		const saved = await findManageableReminder(inv);
		return c
			.update()
			.res(replyData({ message: { content: reply, components: saved ? buildManageButtons(saved) : [] } }));
	},
);

/** [削除] → 確認 */
export const manageDeleteComponent = factory.component(makeButton(MANAGE_DELETE_BUTTON_ID, '削除'), async (c) => {
	const prepared = prepare(c.env.REMINDER_DB, c.interaction, parseReminderId(c.ref.custom_value));
	if (!prepared.ok) {
		return c.flags('EPHEMERAL').res(replyData(prepared.message));
	}
	const reminder = await findManageableReminder(prepared.inv);
	if (!reminder) {
		return c.flags('EPHEMERAL').res(replyData(notFound(prepared.id)));
	}
	return c.update().res(replyData({ message: deleteConfirmView(reminder) }));
});

/** [削除する] → 削除し、開いている通知のボタンを外す */
export const manageDeleteConfirmComponent = factory.component(
	makeButton(MANAGE_DELETE_CONFIRM_BUTTON_ID, '削除する'),
	async (c) => {
		const prepared = prepare(c.env.REMINDER_DB, c.interaction, parseReminderId(c.ref.custom_value));
		if (!prepared.ok) {
			return c.flags('EPHEMERAL').res(replyData(prepared.message));
		}
		// handleDelete も findManageableReminder で確認する。見つからない場合はメッセージを変えずに知らせる
		const { inv } = prepared;
		if (!(await findManageableReminder(inv))) {
			return c.flags('EPHEMERAL').res(replyData(notFound(prepared.id)));
		}
		let reply: Reply;
		try {
			reply = await handleDelete(inv);
		} catch (error) {
			console.error('Unexpected error in reminder manage delete:', error);
			return c.flags('EPHEMERAL').res(replyData(MESSAGES.error));
		}
		if (typeof reply === 'string' || 'message' in reply) {
			return c
				.update()
				.res(replyData(typeof reply === 'string' ? { message: { content: reply, components: [] } } : reply));
		}
		const { deferred } = reply;
		// 通知のボタンを REST で外してから、確認メッセージを結果に書き換える
		return c.update().resDefer(async (d) => {
			let content: string;
			try {
				content = await deferred(d.rest);
			} catch (error) {
				console.error('Unexpected error in reminder manage delete:', error);
				content = MESSAGES.error;
			}
			await d.followup(replyData({ message: { content, components: [] } }));
		});
	},
);

/** [キャンセル] → 選んだリマインダの表示に戻る */
export const manageDeleteCancelComponent = factory.component(
	makeButton(MANAGE_DELETE_CANCEL_BUTTON_ID, 'キャンセル'),
	async (c) => {
		const prepared = prepare(c.env.REMINDER_DB, c.interaction, parseReminderId(c.ref.custom_value));
		if (!prepared.ok) {
			return c.flags('EPHEMERAL').res(replyData(prepared.message));
		}
		const reminder = await findManageableReminder(prepared.inv);
		if (!reminder) {
			return c.flags('EPHEMERAL').res(replyData(notFound(prepared.id)));
		}
		return c.update().res(replyData({ message: manageView(reminder) }));
	},
);

export const reminderGuiManageHandlers = [
	manageSelectComponent,
	manageEditComponent,
	manageToggleComponent,
	manageDeleteComponent,
	manageDeleteConfirmComponent,
	manageDeleteCancelComponent,
];
