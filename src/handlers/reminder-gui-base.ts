/**
 * リマインダ GUI の「繰り返し」選択メニューと基本モーダルの処理。
 * - /remind new の選択メニュー → 新規登録の基本モーダル
 * - 管理画面の [基本設定を編集] の選択メニュー → 現在の値を初期値にした基本モーダル
 * - 基本モーダルの送信 → /remind add・/remind edit と同じ処理で検証・登録・更新
 */
import {
	type APIInteractionDataResolved,
	type APIModalInteractionResponseCallbackData,
	type APIStringSelectComponent,
	ComponentType,
} from 'discord-api-types/v10';
import { factory } from '../factory.ts';
import { utcMsToJst } from '../reminder/date.ts';
import {
	BASE_MODAL_ID,
	type BaseModalState,
	buildBaseModal,
	EDIT_REPEAT_SELECT_ID,
	NEW_REPEAT_SELECT_ID,
	parseBaseModalState,
	parseBaseModalValues,
	parseReminderId,
	parseScheduleType,
	reminderToBaseDefaults,
} from '../reminder/gui.ts';
import { buildScheduleForAdd } from '../reminder/options.ts';
import { LAST_WEEK, type ScheduleType } from '../reminder/schedule.ts';
import type { ReminderDb } from '../types.ts';
import {
	buildInvocation,
	findManageableReminder,
	handleAdd,
	handleEdit,
	type RemindOptions,
	type Reply,
	replyData,
} from './reminder-commands.ts';

const MESSAGES = {
	notConfigured: 'リマインダの保存先が設定されていません。管理者に連絡してください。',
	guildOnly: 'この操作はサーバー内でのみ使用できます。',
	invalidSelect: 'この選択メニューは無効です。もう一度やり直してください。',
	invalidModal: 'この入力画面は無効です。もう一度やり直してください。',
	invalidDay: '日は 1〜31 の整数で入力してください。',
	invalidNth: '第何週かの指定が正しくありません。',
	unknownChannelPermissions:
		'通知先の権限を確認できませんでした。通知先のチャンネルで実行するか、/remind add の channel オプションを使ってください。',
	error: 'エラーが発生しました。時間をおいて再度お試しください。',
} as const;

function notFound(id: number | null): string {
	return `リマインダ #${id ?? '?'} が見つかりません。`;
}

interface InteractionLike {
	guild_id?: string;
	member?: unknown;
	channel?: { id: string };
	channel_id?: string;
}

/** DB とサーバー内であることを確認する。問題があれば応答する文言を返す */
function checkContext(db: ReminderDb | undefined, interaction: InteractionLike): string | null {
	if (!db) {
		console.error('REMINDER_DB binding is not configured.');
		return MESSAGES.notConfigured;
	}
	if (!interaction.member || !interaction.guild_id) {
		return MESSAGES.guildOnly;
	}
	return null;
}

function interactionChannelId(interaction: InteractionLike): string | undefined {
	return interaction.channel?.id ?? interaction.channel_id;
}

/** 選択メニューで選ばれた繰り返しの種類 */
function selectedRepeat(data: object): ScheduleType | null {
	if (!('values' in data) || !Array.isArray(data.values)) {
		return null;
	}
	const [value] = data.values;
	return typeof value === 'string' ? parseScheduleType(value) : null;
}

/** 選択メニューのハンドラ登録用 (キーは custom_id の `;` より前) */
function selectComponent(customId: string) {
	return {
		type: ComponentType.StringSelect,
		custom_id: customId,
		options: [],
	} satisfies APIStringSelectComponent;
}

/** /remind new の「繰り返し」選択 → 新規登録の基本モーダル */
export const reminderNewRepeatSelect = factory.component(selectComponent(NEW_REPEAT_SELECT_ID), (c) => {
	const invalid = checkContext(c.env.REMINDER_DB, c.interaction);
	if (invalid) {
		return c.flags('EPHEMERAL').res(invalid);
	}
	const repeat = selectedRepeat(c.interaction.data);
	if (!repeat) {
		return c.flags('EPHEMERAL').res(MESSAGES.invalidSelect);
	}
	return c.resModal(buildBaseModal({ mode: 'new', repeat }, { channelId: interactionChannelId(c.interaction) }));
});

/** 管理画面の「繰り返し」選択 (custom_value はリマインダ ID) → 現在の値を初期値にした基本モーダル */
export const reminderEditRepeatSelect = factory.component(selectComponent(EDIT_REPEAT_SELECT_ID), async (c) => {
	const db = c.env.REMINDER_DB;
	const invalid = checkContext(db, c.interaction);
	if (invalid || !db) {
		return c.flags('EPHEMERAL').res(invalid ?? MESSAGES.notConfigured);
	}
	const repeat = selectedRepeat(c.interaction.data);
	if (!repeat) {
		return c.flags('EPHEMERAL').res(MESSAGES.invalidSelect);
	}
	const reminderId = parseReminderId(c.ref.custom_value);
	const inv =
		reminderId === null
			? null
			: buildInvocation({ db, interaction: c.interaction, resolved: undefined, opts: { id: reminderId } });
	// 他のサーバーのもの・操作できないものは見つからない扱いにする (custom_id は改変できるため)
	const reminder = inv ? await findManageableReminder(inv) : null;
	if (!reminder) {
		return c.flags('EPHEMERAL').res(replyData(notFound(reminderId)));
	}
	return c.resModal(
		buildBaseModal({ mode: 'edit', repeat, reminderId: reminder.id }, reminderToBaseDefaults(reminder)),
	);
});

/**
 * 基本モーダルの送信値を、/remind add・/remind edit のオプション値にする。
 * 入力の形式の問題があれば、応答する文言を返す。
 */
function buildOptions(
	state: BaseModalState,
	vars: Readonly<Record<string, unknown>>,
	now: number,
): { ok: true; opts: RemindOptions } | { ok: false; message: string } {
	const { content, channel, schedule } = parseBaseModalValues(state.repeat, vars);
	// 日はテキスト入力のため、コマンドの min_value / max_value に当たる確認をここで行う
	if (schedule.day !== undefined && !(Number.isInteger(schedule.day) && schedule.day >= 1 && schedule.day <= 31)) {
		return { ok: false, message: MESSAGES.invalidDay };
	}
	if (
		schedule.nth !== undefined &&
		!(Number.isInteger(schedule.nth) && schedule.nth >= 1 && schedule.nth <= LAST_WEEK)
	) {
		return { ok: false, message: MESSAGES.invalidNth };
	}
	const opts: RemindOptions = { content, channel, ...schedule };
	if (state.mode === 'edit') {
		opts.id = state.reminderId;
		// 基本モーダルは基本設定をすべて置き換える。
		if (state.repeat === 'once') {
			// 1回のみには祝日の扱いがないため、繰り返しから変えた場合も「通知する」に戻す
			opts.holidays = 'notify';
			// 日付を空欄にした場合は、新規登録と同じく次に来るその時刻にする
			// (edit は日付を省略すると今の実行日を保つため、日付を補う)
			if (opts.date === undefined && opts.time !== undefined) {
				const next = buildScheduleForAdd({ repeat: 'once', time: opts.time }, now);
				if (next.ok && next.value.once_at !== null) {
					opts.date = utcMsToJst(next.value.once_at).date;
				}
			}
		}
	}
	return { ok: true, opts };
}

/**
 * 通知先が実行したチャンネルと異なる場合、実行者の権限は解決済みデータの permissions でしか分からない。
 * モーダルのチャンネル選択で permissions が届かない場合に「投稿する権限がない」と誤って案内しないよう確認する
 */
function hasTargetPermissions(
	channel: string | undefined,
	channelId: string | undefined,
	resolved: APIInteractionDataResolved | undefined,
): boolean {
	if (channel === undefined || channel === channelId) {
		return true;
	}
	const permissions: unknown = resolved?.channels?.[channel]?.permissions;
	return typeof permissions === 'string' && permissions !== '';
}

/** 基本モーダルの送信 (custom_value は `new:{repeat}` または `edit:{repeat}:{reminderId}`) */
export const reminderBaseModal = factory.modal<APIModalInteractionResponseCallbackData, Record<string, unknown>>(
	// ハンドラ登録用。実際に開くモーダルは buildBaseModal で毎回組み立てる
	{ custom_id: BASE_MODAL_ID, title: 'リマインダ', components: [] },
	async (c) => {
		const ephemeral = c.flags('EPHEMERAL');
		const db = c.env.REMINDER_DB;
		const invalid = checkContext(db, c.interaction);
		if (invalid || !db) {
			return ephemeral.res(invalid ?? MESSAGES.notConfigured);
		}
		const state = parseBaseModalState(c.ref.custom_value);
		if (!state) {
			return ephemeral.res(MESSAGES.invalidModal);
		}
		const now = Date.now();
		const options = buildOptions(state, c.var, now);
		if (!options.ok) {
			return ephemeral.res(replyData(options.message));
		}
		const resolved = c.interaction.data.resolved;
		if (!hasTargetPermissions(options.opts.channel, interactionChannelId(c.interaction), resolved)) {
			return ephemeral.res(replyData(MESSAGES.unknownChannelPermissions));
		}
		const inv = buildInvocation({ db, interaction: c.interaction, resolved, opts: options.opts, now });
		if (!inv) {
			return ephemeral.res(MESSAGES.guildOnly);
		}

		let reply: Reply;
		try {
			reply = state.mode === 'new' ? await handleAdd(inv) : await handleEdit(inv);
		} catch (error) {
			console.error(`Unexpected error in reminder base modal (${state.mode}):`, error);
			return ephemeral.res(replyData(MESSAGES.error));
		}
		if (typeof reply === 'string' || 'message' in reply) {
			return ephemeral.res(replyData(reply));
		}
		const { deferred } = reply;
		return ephemeral.resDefer(async (d) => {
			let content: string;
			try {
				content = await deferred(d.rest);
			} catch (error) {
				console.error(`Unexpected error in reminder base modal (${state.mode}):`, error);
				content = MESSAGES.error;
			}
			await d.followup(replyData(content));
		});
	},
);

export const reminderGuiBaseHandlers = [reminderNewRepeatSelect, reminderEditRepeatSelect, reminderBaseModal];
