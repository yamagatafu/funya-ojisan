/**
 * 詳細設定 (通知設定・期間と祝日) のボタンとモーダルのハンドラ。
 * ボタンで現在の値を初期値にしたモーダルを開き、送信値を `/remind edit` と同じ handleEdit で保存する
 * (検証・権限・ロールメンションの制限・楽観的排他制御は /remind edit と同じ)。
 */
import type { APIInteractionDataResolved, APIModalInteractionResponseCallbackData } from 'discord-api-types/v10';
import { makeButton, makeModal } from 'discord-hono';
import { factory } from '../factory.ts';
import {
	NOTIFY_SETTINGS_BUTTON_ID,
	NOTIFY_SETTINGS_MODAL_ID,
	PERIOD_SETTINGS_BUTTON_ID,
	PERIOD_SETTINGS_MODAL_ID,
	parseReminderId,
} from '../reminder/gui.ts';
import {
	buildNotifySettingsModal,
	buildPeriodSettingsModal,
	type DetailEditOptions,
	parseNotifySettingsValues,
	parsePeriodSettingsValues,
} from '../reminder/gui-details.ts';
import type { OptionResult } from '../reminder/options.ts';
import type { ReminderRow } from '../reminder/repository.ts';
import type { ReminderDb } from '../types.ts';
import {
	buildInvocation,
	findManageableReminder,
	handleEdit,
	type Invocation,
	replyData,
} from './reminder-commands.ts';

const MESSAGES = {
	notConfigured: 'リマインダの保存先が設定されていません。管理者に連絡してください。',
	guildOnly: 'このボタンはサーバー内でのみ使用できます。',
	onceHasNoPeriod: '1回のみのリマインダには期間・祝日を設定できません。',
	error: 'エラーが発生しました。時間をおいて再度お試しください。',
} as const;

function notFound(id: number | null): string {
	return `リマインダ #${id ?? '?'} が見つかりません。`;
}

/** ボタン・モーダルのインタラクションのうち、Invocation の組み立てに使う部分 */
type InteractionLike = Parameters<typeof buildInvocation>[0]['interaction'];

type Loaded = { ok: true; inv: Invocation; reminder: ReminderRow } | { ok: false; message: string };

/** custom_value のリマインダ ID から、操作できるリマインダを読み込む (他のサーバー・権限なしは見つからない扱い) */
async function loadReminder(
	db: ReminderDb | undefined,
	interaction: InteractionLike,
	customValue: string | undefined,
	resolved: APIInteractionDataResolved | undefined,
): Promise<Loaded> {
	if (!db) {
		console.error('REMINDER_DB binding is not configured.');
		return { ok: false, message: MESSAGES.notConfigured };
	}
	const id = parseReminderId(customValue);
	const inv = buildInvocation({ db, interaction, resolved, opts: { id: id ?? undefined } });
	if (!inv) {
		return { ok: false, message: MESSAGES.guildOnly };
	}
	const reminder = id === null ? null : await findManageableReminder(inv);
	return reminder ? { ok: true, inv, reminder } : { ok: false, message: notFound(id) };
}

/** ボタン: 対象のリマインダを確認してモーダルを開く */
async function openModal(
	db: ReminderDb | undefined,
	interaction: InteractionLike,
	customValue: string | undefined,
	build: (reminder: ReminderRow) => APIModalInteractionResponseCallbackData | string,
): Promise<APIModalInteractionResponseCallbackData | string> {
	try {
		const loaded = await loadReminder(db, interaction, customValue, undefined);
		return loaded.ok ? build(loaded.reminder) : loaded.message;
	} catch (error) {
		console.error('Unexpected error while opening a reminder detail modal:', error);
		return MESSAGES.error;
	}
}

/** モーダルの送信: 送信値を /remind edit のオプション値に変換して保存する */
async function submitModal(
	db: ReminderDb | undefined,
	interaction: InteractionLike,
	customValue: string | undefined,
	resolved: APIInteractionDataResolved | undefined,
	parse: (reminder: ReminderRow) => OptionResult<DetailEditOptions>,
): Promise<ReturnType<typeof replyData>> {
	try {
		const loaded = await loadReminder(db, interaction, customValue, resolved);
		if (!loaded.ok) {
			return replyData(loaded.message);
		}
		const options = parse(loaded.reminder);
		if (!options.ok) {
			return replyData(options.message);
		}
		const { inv, reminder } = loaded;
		const reply = await handleEdit({ ...inv, opts: { ...options.value, id: reminder.id } });
		// handleEdit は遅延応答を返さない
		return typeof reply === 'string' || 'message' in reply ? replyData(reply) : replyData(MESSAGES.error);
	} catch (error) {
		console.error('Unexpected error while saving reminder details:', error);
		return replyData(MESSAGES.error);
	}
}

/** [通知設定] ボタン */
export const notifySettingsButton = factory.component(makeButton(NOTIFY_SETTINGS_BUTTON_ID, '通知設定'), async (c) => {
	const result = await openModal(c.env.REMINDER_DB, c.interaction, c.ref.custom_value, buildNotifySettingsModal);
	return typeof result === 'string' ? c.flags('EPHEMERAL').res(replyData(result)) : c.resModal(result);
});

/** [期間・祝日] ボタン (繰り返しのみ) */
export const periodSettingsButton = factory.component(
	makeButton(PERIOD_SETTINGS_BUTTON_ID, '期間・祝日'),
	async (c) => {
		const result = await openModal(c.env.REMINDER_DB, c.interaction, c.ref.custom_value, (reminder) =>
			reminder.schedule_type === 'once' ? MESSAGES.onceHasNoPeriod : buildPeriodSettingsModal(reminder),
		);
		return typeof result === 'string' ? c.flags('EPHEMERAL').res(replyData(result)) : c.resModal(result);
	},
);

/** 通知設定モーダルの送信 */
export const notifySettingsModal = factory.modal(makeModal(NOTIFY_SETTINGS_MODAL_ID, '通知設定', []), async (c) => {
	const data = await submitModal(
		c.env.REMINDER_DB,
		c.interaction,
		c.ref.custom_value,
		c.interaction.data.resolved,
		(reminder) => parseNotifySettingsValues(reminder, c.var),
	);
	return c.flags('EPHEMERAL').res(data);
});

/** 期間・祝日モーダルの送信 */
export const periodSettingsModal = factory.modal(makeModal(PERIOD_SETTINGS_MODAL_ID, '期間・祝日', []), async (c) => {
	const data = await submitModal(
		c.env.REMINDER_DB,
		c.interaction,
		c.ref.custom_value,
		c.interaction.data.resolved,
		(reminder) => parsePeriodSettingsValues(reminder, c.var),
	);
	return c.flags('EPHEMERAL').res(data);
});

export const reminderGuiDetailHandlers = [
	notifySettingsButton,
	periodSettingsButton,
	notifySettingsModal,
	periodSettingsModal,
];
