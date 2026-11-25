/**
 * 詳細設定モーダル (通知設定・期間と祝日) の組み立てと送信値の変換 (純粋関数)。
 * - 開くときは保存済みの値を初期値にする
 * - 送信値は `/remind edit` のオプション値に変換し、検証・保存は handleEdit に任せる
 * - 空欄は解除として扱う (`/remind edit` の 0 / なし と同じ)
 */
import {
	type APILabelComponent,
	type APIModalInteractionResponseCallbackData,
	type APISelectMenuDefaultValue,
	type APITextInputComponent,
	ComponentType,
	SelectMenuDefaultValueType,
	TextInputStyle,
} from 'discord-api-types/v10';
import {
	arrayValue,
	integerText,
	label,
	NOTIFY_SETTINGS_MODAL_ID,
	PERIOD_SETTINGS_MODAL_ID,
	stringValue,
} from './gui.ts';
import { DEFAULT_NAG_MAX, HOLIDAY_LABELS, type OptionResult, type ScheduleOptionValues } from './options.ts';
import type { ReminderRow } from './repository.ts';
import { HOLIDAY_POLICIES } from './schedule.ts';

/** 通知設定モーダルの項目の custom_id (コマンドのオプション名とそろえる) */
export const NOTIFY_FIELD = {
	mention: 'mention',
	preNotify: 'pre_notify',
	nagInterval: 'nag_interval',
	nagMax: 'nag_max',
} as const;

/** 期間・祝日モーダルの項目の custom_id (コマンドのオプション名とそろえる) */
export const PERIOD_FIELD = {
	date: 'date',
	holidays: 'holidays',
	until: 'until',
	count: 'count',
} as const;

/** 数値の項目の範囲 (コマンドのオプションの min_value / max_value と同じ。0 は解除) */
const RANGES = {
	preNotify: { label: '事前通知（分）', min: 0, max: 1440 },
	nagInterval: { label: '完了まで再通知する間隔（分）', min: 0, max: 1440 },
	nagMax: { label: '再通知の最大回数', min: 1, max: 10 },
	count: { label: '回数', min: 0, max: 1000 },
} as const;

/** `/remind edit` に渡すオプション値 (RemindOptions の一部) */
export interface DetailEditOptions extends ScheduleOptionValues {
	mention?: string;
}

function numberInput(customId: string, value: number | null, placeholder: string): APITextInputComponent {
	return {
		type: ComponentType.TextInput,
		custom_id: customId,
		style: TextInputStyle.Short,
		required: false,
		max_length: 4,
		placeholder,
		...(value !== null ? { value: String(value) } : {}),
	};
}

function title(text: string, reminder: Pick<ReminderRow, 'id'>): string {
	return `リマインダ #${reminder.id} の${text}`;
}

/** 現在のメンション先の ID (自分の場合は登録者の ID) */
function currentMentionId(reminder: Pick<ReminderRow, 'mention_type' | 'mention_target_id' | 'owner_id'>): string {
	return reminder.mention_type === 'self' || reminder.mention_target_id === null
		? reminder.owner_id
		: reminder.mention_target_id;
}

// ---- 通知設定 ----

/** メンション先の選択の初期値 (自分の場合は未選択) */
function mentionDefaultValue(
	reminder: Pick<ReminderRow, 'mention_type' | 'mention_target_id'>,
): APISelectMenuDefaultValue<SelectMenuDefaultValueType.Role | SelectMenuDefaultValueType.User> | undefined {
	const id = reminder.mention_target_id;
	if (id === null) {
		return undefined;
	}
	if (reminder.mention_type === 'user') {
		return { id, type: SelectMenuDefaultValueType.User };
	}
	if (reminder.mention_type === 'role') {
		return { id, type: SelectMenuDefaultValueType.Role };
	}
	return undefined;
}

export function buildNotifySettingsModal(reminder: ReminderRow): APIModalInteractionResponseCallbackData {
	const defaultValue = mentionDefaultValue(reminder);
	const components: APILabelComponent[] = [
		label(
			'メンション先',
			{
				type: ComponentType.MentionableSelect,
				custom_id: NOTIFY_FIELD.mention,
				required: false,
				min_values: 0,
				max_values: 1,
				...(defaultValue ? { default_values: [defaultValue] } : {}),
			},
			'未選択なら自分',
		),
		label(
			RANGES.preNotify.label,
			numberInput(NOTIFY_FIELD.preNotify, reminder.pre_notify_minutes, '例: 10'),
			'空欄なら事前通知しません',
		),
		label(
			RANGES.nagInterval.label,
			numberInput(NOTIFY_FIELD.nagInterval, reminder.nag_interval_minutes, '例: 30'),
			'5 分以上。空欄なら再通知しません',
		),
		label(
			RANGES.nagMax.label,
			numberInput(NOTIFY_FIELD.nagMax, reminder.nag_max_count, String(DEFAULT_NAG_MAX)),
			`1〜10。空欄なら ${DEFAULT_NAG_MAX} 回`,
		),
	];
	return {
		custom_id: `${NOTIFY_SETTINGS_MODAL_ID};${reminder.id}`,
		title: title('通知設定', reminder),
		components,
	};
}

/**
 * 整数の項目を読み取る。空欄は undefined、整数でない・範囲外ならエラー
 */
function readInteger(
	vars: Readonly<Record<string, unknown>>,
	customId: string,
	range: { label: string; min: number; max: number },
): OptionResult<number | undefined> {
	const value = integerText(stringValue(vars, customId));
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
		return { ok: false, message: `「${range.label}」は ${range.min}〜${range.max} の整数で入力してください。` };
	}
	return { ok: true, value };
}

/**
 * 通知設定モーダルの送信値を `/remind edit` のオプション値に変換する。
 * - 事前通知・再通知の間隔は常に送る (空欄は 0 = 解除)
 * - 再通知の最大回数は、間隔がある場合だけ送る (空欄は既定の回数)
 * - メンション先は変えた場合だけ送る (未選択は登録者 = 自分)。
 *   変えていないロールメンションを、編集のたびにロールの権限で確認し直さないため
 */
export function parseNotifySettingsValues(
	reminder: Pick<ReminderRow, 'mention_type' | 'mention_target_id' | 'owner_id'>,
	vars: Readonly<Record<string, unknown>>,
): OptionResult<DetailEditOptions> {
	const preNotify = readInteger(vars, NOTIFY_FIELD.preNotify, RANGES.preNotify);
	if (!preNotify.ok) {
		return preNotify;
	}
	const nagInterval = readInteger(vars, NOTIFY_FIELD.nagInterval, RANGES.nagInterval);
	if (!nagInterval.ok) {
		return nagInterval;
	}
	const nagMax = readInteger(vars, NOTIFY_FIELD.nagMax, RANGES.nagMax);
	if (!nagMax.ok) {
		return nagMax;
	}
	// 間隔が空欄なら再通知を解除する (最大回数の欄に値が残っていても無視する)
	const interval = nagInterval.value ?? 0;

	const options: DetailEditOptions = {
		pre_notify: preNotify.value ?? 0,
		nag_interval: interval,
	};
	if (interval > 0) {
		options.nag_max = nagMax.value ?? DEFAULT_NAG_MAX;
	}
	const mention = arrayValue(vars, NOTIFY_FIELD.mention)[0] ?? reminder.owner_id;
	if (mention !== currentMentionId(reminder)) {
		options.mention = mention;
	}
	return { ok: true, value: options };
}

// ---- 期間・祝日 ----

export function buildPeriodSettingsModal(reminder: ReminderRow): APIModalInteractionResponseCallbackData {
	const components: APILabelComponent[] = [
		label(
			'開始日',
			{
				type: ComponentType.TextInput,
				custom_id: PERIOD_FIELD.date,
				style: TextInputStyle.Short,
				required: false,
				placeholder: '2026-12-01',
				...(reminder.start_date ? { value: reminder.start_date } : {}),
			},
			'YYYY-MM-DD。空欄なら変更しません',
		),
		label('祝日の扱い', {
			type: ComponentType.RadioGroup,
			custom_id: PERIOD_FIELD.holidays,
			required: true,
			options: HOLIDAY_POLICIES.map((policy) => ({
				value: policy,
				label: HOLIDAY_LABELS[policy],
				default: policy === reminder.holiday_policy,
			})),
		}),
		label(
			'終了日',
			{
				type: ComponentType.TextInput,
				custom_id: PERIOD_FIELD.until,
				style: TextInputStyle.Short,
				required: false,
				placeholder: '2026-12-31',
				...(reminder.end_date ? { value: reminder.end_date } : {}),
			},
			'YYYY-MM-DD。空欄なら終了日なし',
		),
		label(
			RANGES.count.label,
			numberInput(PERIOD_FIELD.count, reminder.remaining_count, '例: 10'),
			'残りの通知回数。空欄なら無制限',
		),
	];
	return {
		custom_id: `${PERIOD_SETTINGS_MODAL_ID};${reminder.id}`,
		title: title('期間・祝日', reminder),
		components,
	};
}

/**
 * 期間・祝日モーダルの送信値を `/remind edit` のオプション値に変換する。
 * - 回数は常に送る (空欄は 0 = 無制限)
 * - 終了日の空欄は「なし」(解除)。開始日の空欄は変更しない
 * - 開始日・終了日は変えた場合だけ送る (過ぎた日付がそのまま残っていても保存できるように)
 */
export function parsePeriodSettingsValues(
	reminder: Pick<ReminderRow, 'start_date' | 'end_date'>,
	vars: Readonly<Record<string, unknown>>,
): OptionResult<DetailEditOptions> {
	const count = readInteger(vars, PERIOD_FIELD.count, RANGES.count);
	if (!count.ok) {
		return count;
	}
	const options: DetailEditOptions = { count: count.value ?? 0 };

	const holidays = stringValue(vars, PERIOD_FIELD.holidays);
	if (holidays !== undefined) {
		options.holidays = holidays;
	}

	const date = stringValue(vars, PERIOD_FIELD.date)?.trim();
	if (date !== undefined && date !== reminder.start_date) {
		options.date = date;
	}

	const until = stringValue(vars, PERIOD_FIELD.until)?.trim();
	if (until === undefined) {
		if (reminder.end_date !== null) {
			options.until = 'なし';
		}
	} else if (until !== reminder.end_date) {
		options.until = until;
	}
	return { ok: true, value: options };
}
