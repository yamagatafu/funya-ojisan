/**
 * リマインダの GUI (選択メニュー・ボタン・モーダル) の共通部品。
 * - custom_id の定義
 * - 「繰り返し」の選択メニュー
 * - 基本モーダル (繰り返しの種類ごとの項目) の組み立てと送信値の変換
 * - 詳細設定 (通知設定・期間と祝日) を開くボタン
 *
 * 入力の検証・登録・更新は options.ts / service.ts / permissions.ts の既存の関数で行い、
 * ここでは Discord の部品とコマンドのオプション値 (RemindOptions) の相互変換だけを扱う。
 */
import {
	type APIActionRowComponent,
	type APIButtonComponentWithCustomId,
	type APIComponentInLabel,
	type APILabelComponent,
	type APIModalInteractionResponseCallbackData,
	type APIStringSelectComponent,
	ButtonStyle,
	ComponentType,
	SelectMenuDefaultValueType,
	TextInputStyle,
} from 'discord-api-types/v10';
import { formatMinutesOfDay, utcMsToJst } from './date.ts';
import { formatWeekdays } from './format.ts';
import { REPEAT_LABELS, type ScheduleOptionValues } from './options.ts';
import { MAX_CONTENT_LENGTH, REMINDER_CHANNEL_TYPES } from './permissions.ts';
import type { ReminderRow } from './repository.ts';
import { LAST_WEEK, SCHEDULE_TYPES, type ScheduleType } from './schedule.ts';

// ---- custom_id ----
// discord-hono はセミコロンより前をハンドラのキー、後ろを c.ref.custom_value として扱う

/** /remind new の「繰り返し」選択メニュー (値なし) */
export const NEW_REPEAT_SELECT_ID = 'remind_new_repeat';
/** 管理画面の [基本設定を編集] の「繰り返し」選択メニュー (`{reminderId}`) */
export const EDIT_REPEAT_SELECT_ID = 'remind_edit_repeat';
/** 基本モーダル (`new:{repeat}` または `edit:{repeat}:{reminderId}`) */
export const BASE_MODAL_ID = 'remind_base_modal';
/** [通知設定] ボタン・モーダル (`{reminderId}`) */
export const NOTIFY_SETTINGS_BUTTON_ID = 'remind_notify_settings';
export const NOTIFY_SETTINGS_MODAL_ID = 'remind_notify_modal';
/** [期間・祝日] ボタン・モーダル (`{reminderId}`) */
export const PERIOD_SETTINGS_BUTTON_ID = 'remind_period_settings';
export const PERIOD_SETTINGS_MODAL_ID = 'remind_period_modal';
/** 管理画面: 対象の選択メニュー (値なし) と操作ボタン (`{reminderId}`) */
export const MANAGE_SELECT_ID = 'remind_manage_select';
export const MANAGE_EDIT_BUTTON_ID = 'remind_manage_edit';
export const MANAGE_TOGGLE_BUTTON_ID = 'remind_manage_toggle';
export const MANAGE_DELETE_BUTTON_ID = 'remind_manage_delete';
export const MANAGE_DELETE_CONFIRM_BUTTON_ID = 'remind_manage_delete_confirm';
export const MANAGE_DELETE_CANCEL_BUTTON_ID = 'remind_manage_delete_cancel';

/** 基本モーダルの項目の custom_id (コマンドのオプション名とそろえる) */
export const BASE_FIELD = {
	content: 'content',
	date: 'date',
	time: 'time',
	weekdays: 'weekdays',
	day: 'day',
	nth: 'nth',
	weekday: 'weekday',
	channel: 'channel',
} as const;

/** 正の整数の ID を解釈する。不正なら null */
export function parseReminderId(value: string | undefined): number | null {
	if (!value || !/^[1-9]\d{0,14}$/.test(value)) {
		return null;
	}
	return Number(value);
}

export function parseScheduleType(value: string | undefined): ScheduleType | null {
	return SCHEDULE_TYPES.find((type) => type === value) ?? null;
}

// ---- 基本モーダルの状態 (custom_value) ----

export type BaseModalState =
	| { mode: 'new'; repeat: ScheduleType }
	| { mode: 'edit'; repeat: ScheduleType; reminderId: number };

export function formatBaseModalState(state: BaseModalState): string {
	return state.mode === 'new' ? `new:${state.repeat}` : `edit:${state.repeat}:${state.reminderId}`;
}

export function parseBaseModalState(value: string | undefined): BaseModalState | null {
	const parts = (value ?? '').split(':');
	if (parts.length > 3) {
		return null;
	}
	const [mode, repeatValue, idValue] = parts;
	const repeat = parseScheduleType(repeatValue);
	if (!repeat) {
		return null;
	}
	if (mode === 'new' && idValue === undefined) {
		return { mode: 'new', repeat };
	}
	const reminderId = parseReminderId(idValue);
	return mode === 'edit' && reminderId !== null ? { mode: 'edit', repeat, reminderId } : null;
}

// ---- 「繰り返し」の選択メニュー ----

/**
 * 「繰り返し」の選択メニュー。
 * 現在の種類は default ではなくプレースホルダーに表示する。default にした選択肢は選び直しても
 * イベントが発生しないため、「繰り返しはそのままで内容だけ編集する」操作ができなくなる
 */
export function buildRepeatSelect(
	customId: string,
	current?: ScheduleType,
): APIActionRowComponent<APIStringSelectComponent> {
	return {
		type: ComponentType.ActionRow,
		components: [
			{
				type: ComponentType.StringSelect,
				custom_id: customId,
				placeholder: current
					? `繰り返しを選んでください（現在: ${REPEAT_LABELS[current]}）`
					: '繰り返しを選んでください',
				options: SCHEDULE_TYPES.map((type) => ({ label: REPEAT_LABELS[type], value: type })),
			},
		],
	};
}

// ---- 基本モーダル ----

/** 曜日 (表示順: 月曜始まり) */
const WEEKDAY_OPTIONS: { value: string; label: string }[] = [
	{ value: '1', label: '月' },
	{ value: '2', label: '火' },
	{ value: '3', label: '水' },
	{ value: '4', label: '木' },
	{ value: '5', label: '金' },
	{ value: '6', label: '土' },
	{ value: '0', label: '日' },
];

const NTH_OPTIONS: { value: string; label: string }[] = [
	{ value: '1', label: '第1' },
	{ value: '2', label: '第2' },
	{ value: '3', label: '第3' },
	{ value: '4', label: '第4' },
	{ value: String(LAST_WEEK), label: '最終' },
];

/** 基本モーダルの初期値 */
export interface BaseModalDefaults {
	content?: string;
	/** YYYY-MM-DD (1回のみ) */
	date?: string;
	/** HH:MM */
	time?: string;
	/** bit0=日 ... bit6=土 */
	weekdaysMask?: number | null;
	day?: number | null;
	nth?: number | null;
	/** 通知先 (既定値はコマンドを実行したチャンネル) */
	channelId?: string;
}

/** 保存済みのリマインダから、基本モーダルの初期値を作る (編集用) */
export function reminderToBaseDefaults(reminder: ReminderRow): BaseModalDefaults {
	return {
		content: reminder.content,
		date: reminder.once_at === null ? undefined : utcMsToJst(reminder.once_at).date,
		time: formatMinutesOfDay(reminder.time_of_day),
		weekdaysMask: reminder.weekdays_mask,
		day: reminder.day_of_month,
		nth: reminder.nth_week,
		channelId: reminder.channel_id,
	};
}

function label(text: string, component: APIComponentInLabel, description?: string): APILabelComponent {
	return { type: ComponentType.Label, label: text, ...(description ? { description } : {}), component };
}

function hasWeekday(mask: number | null | undefined, weekday: string): boolean {
	return mask !== null && mask !== undefined && (mask & (1 << Number(weekday))) !== 0;
}

/** 曜日マスクのうち最初の曜日 (第n曜日の初期値用) */
function firstWeekday(mask: number | null | undefined): string | undefined {
	return WEEKDAY_OPTIONS.find((option) => hasWeekday(mask, option.value))?.value;
}

/**
 * 繰り返しの種類に合わせた基本モーダルを組み立てる (項目は最大 5 つ)。
 * 呼び出しのたびに新しいオブジェクトを返す (共有の builder を書き換えない)。
 */
export function buildBaseModal(
	state: BaseModalState,
	defaults: BaseModalDefaults,
): APIModalInteractionResponseCallbackData {
	const { repeat } = state;
	const components: APILabelComponent[] = [
		label('内容', {
			type: ComponentType.TextInput,
			custom_id: BASE_FIELD.content,
			style: TextInputStyle.Paragraph,
			required: true,
			max_length: MAX_CONTENT_LENGTH,
			...(defaults.content ? { value: defaults.content } : {}),
		}),
	];

	if (repeat === 'once') {
		components.push(
			label(
				'日付',
				{
					type: ComponentType.TextInput,
					custom_id: BASE_FIELD.date,
					style: TextInputStyle.Short,
					required: false,
					placeholder: '2026-12-01 または 12/1',
					...(defaults.date ? { value: defaults.date } : {}),
				},
				'省略すると、次に来るその時刻に通知します',
			),
		);
	}

	components.push(
		label('時刻', {
			type: ComponentType.TextInput,
			custom_id: BASE_FIELD.time,
			style: TextInputStyle.Short,
			required: true,
			placeholder: '09:00',
			...(defaults.time ? { value: defaults.time } : {}),
		}),
	);

	if (repeat === 'weekly' || repeat === 'biweekly') {
		components.push(
			label('曜日', {
				type: ComponentType.CheckboxGroup,
				custom_id: BASE_FIELD.weekdays,
				required: true,
				min_values: 1,
				options: WEEKDAY_OPTIONS.map((option) => ({
					...option,
					default: hasWeekday(defaults.weekdaysMask, option.value),
				})),
			}),
		);
	}

	if (repeat === 'monthly_day') {
		components.push(
			label(
				'日',
				{
					type: ComponentType.TextInput,
					custom_id: BASE_FIELD.day,
					style: TextInputStyle.Short,
					required: true,
					max_length: 2,
					placeholder: '15',
					...(defaults.day ? { value: String(defaults.day) } : {}),
				},
				'1〜31（その月にない日は月末に通知します）',
			),
		);
	}

	if (repeat === 'monthly_nth_weekday') {
		const weekday = firstWeekday(defaults.weekdaysMask);
		components.push(
			label('第何週', {
				type: ComponentType.RadioGroup,
				custom_id: BASE_FIELD.nth,
				required: true,
				options: NTH_OPTIONS.map((option) => ({ ...option, default: option.value === String(defaults.nth) })),
			}),
			label('曜日', {
				type: ComponentType.RadioGroup,
				custom_id: BASE_FIELD.weekday,
				required: true,
				options: WEEKDAY_OPTIONS.map((option) => ({ ...option, default: option.value === weekday })),
			}),
		);
	}

	components.push(
		label('通知先', {
			type: ComponentType.ChannelSelect,
			custom_id: BASE_FIELD.channel,
			channel_types: [...REMINDER_CHANNEL_TYPES],
			required: true,
			min_values: 1,
			max_values: 1,
			...(defaults.channelId
				? { default_values: [{ id: defaults.channelId, type: SelectMenuDefaultValueType.Channel }] }
				: {}),
		}),
	);

	return {
		custom_id: `${BASE_MODAL_ID};${formatBaseModalState(state)}`,
		title: `${state.mode === 'new' ? 'リマインダを登録' : 'リマインダを編集'}（${REPEAT_LABELS[repeat]}）`,
		components,
	};
}

/** 基本モーダルの送信値をコマンドのオプション値に変換した結果 */
export interface BaseModalValues {
	content: string | undefined;
	/** 選択された通知先チャンネル */
	channel: string | undefined;
	schedule: ScheduleOptionValues;
}

function stringValue(vars: Readonly<Record<string, unknown>>, name: string): string | undefined {
	const value = vars[name];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function arrayValue(vars: Readonly<Record<string, unknown>>, name: string): string[] {
	const value = vars[name];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 曜日番号 ('0'〜'6') の配列を、コマンドと同じ曜日の文字列 (例: `月水金`) に変換する */
function weekdaysToText(values: string[]): string | undefined {
	const mask = values.reduce((acc, value) => {
		const weekday = Number(value);
		return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? acc | (1 << weekday) : acc;
	}, 0);
	return mask === 0 ? undefined : formatWeekdays(mask);
}

/** 整数のテキスト入力を数値に変換する。空欄は undefined、整数でなければ NaN (検証でエラーにする) */
function integerText(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = value.normalize('NFKC').trim();
	return /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
}

/**
 * 基本モーダルの送信値 (c.var) を、コマンドのオプション値に変換する。
 * 変換後は buildScheduleForAdd / buildScheduleForEdit で検証する。
 */
export function parseBaseModalValues(repeat: ScheduleType, vars: Readonly<Record<string, unknown>>): BaseModalValues {
	const schedule: ScheduleOptionValues = {
		repeat,
		time: stringValue(vars, BASE_FIELD.time),
	};
	if (repeat === 'once') {
		schedule.date = stringValue(vars, BASE_FIELD.date);
	}
	if (repeat === 'weekly' || repeat === 'biweekly') {
		schedule.weekdays = weekdaysToText(arrayValue(vars, BASE_FIELD.weekdays));
	}
	if (repeat === 'monthly_day') {
		schedule.day = integerText(stringValue(vars, BASE_FIELD.day));
	}
	if (repeat === 'monthly_nth_weekday') {
		schedule.nth = integerText(stringValue(vars, BASE_FIELD.nth));
		const weekday = stringValue(vars, BASE_FIELD.weekday);
		schedule.weekdays = weekday === undefined ? undefined : weekdaysToText([weekday]);
	}
	return {
		content: stringValue(vars, BASE_FIELD.content),
		channel: arrayValue(vars, BASE_FIELD.channel)[0],
		schedule,
	};
}

// ---- 詳細設定を開くボタン ----

/** 登録・編集の結果や管理画面に付ける [通知設定] [期間・祝日] ボタン (期間・祝日は繰り返しのみ) */
export function buildDetailButtons(
	reminder: Pick<ReminderRow, 'id' | 'schedule_type'>,
): APIActionRowComponent<APIButtonComponentWithCustomId> {
	const buttons: APIButtonComponentWithCustomId[] = [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: '通知設定',
			emoji: { name: '🔔' },
			custom_id: `${NOTIFY_SETTINGS_BUTTON_ID};${reminder.id}`,
		},
	];
	if (reminder.schedule_type !== 'once') {
		buttons.push({
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: '期間・祝日',
			emoji: { name: '📅' },
			custom_id: `${PERIOD_SETTINGS_BUTTON_ID};${reminder.id}`,
		});
	}
	return { type: ComponentType.ActionRow, components: buttons };
}
