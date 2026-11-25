/**
 * `/remind` のオプションの解釈と検証 (純粋関数)。
 * Discord から受け取った生の値を、リマインダのスケジュール関連の列に変換する。
 */
import type { APIInteractionDataResolved } from 'discord-api-types/v10';
import { DAY_MS, formatDate, jstToUtcMs, MINUTE_MS, utcMsToJst } from './date.ts';
import { type PartialDate, parsePartialDate, parseTime, parseWeekdays, resolveDate } from './parse.ts';
import type { MentionSpec } from './permissions.ts';
import type { ReminderRow } from './repository.ts';
import { HOLIDAY_POLICIES, type HolidayPolicy, SCHEDULE_TYPES, type ScheduleType } from './schedule.ts';

export type OptionResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** スケジュールに関わる列 */
export type ScheduleFields = Pick<
	ReminderRow,
	| 'schedule_type'
	| 'time_of_day'
	| 'once_at'
	| 'weekdays_mask'
	| 'day_of_month'
	| 'nth_week'
	| 'start_date'
	| 'holiday_policy'
	| 'pre_notify_minutes'
	| 'nag_interval_minutes'
	| 'nag_max_count'
	| 'end_date'
	| 'remaining_count'
>;

/** スケジュールに関わるオプションの生の値 */
export interface ScheduleOptionValues {
	time?: string;
	repeat?: string;
	date?: string;
	weekdays?: string;
	day?: number;
	nth?: number;
	pre_notify?: number;
	nag_interval?: number;
	nag_max?: number;
	holidays?: string;
	until?: string;
	count?: number;
}

export const REPEAT_LABELS: Record<ScheduleType, string> = {
	once: '1回のみ',
	daily: '毎日',
	weekdays: '平日',
	weekly: '毎週',
	biweekly: '隔週',
	monthly_day: '毎月n日',
	monthly_last: '毎月末日',
	monthly_nth_weekday: '毎月第n曜日',
};

export const HOLIDAY_LABELS: Record<HolidayPolicy, string> = {
	notify: '通知する',
	skip: 'スキップ',
	shift: '次の平日にずらす',
};

/** `nag_interval` だけを指定した場合の再通知の最大回数 */
export const DEFAULT_NAG_MAX = 3;
/** 再通知の最短間隔 (分) */
export const MIN_NAG_INTERVAL = 5;
/** `/remind in` で指定できる最大の長さ */
export const MAX_RELATIVE_MINUTES = 365 * 24 * 60;
/** `until` で終了日を消すときの値 */
const CLEAR_WORDS = new Set(['なし', '無し', 'none', '-']);

export const ONCE_HOLIDAY_ERROR = '1回のみのリマインダには祝日の扱いを指定できません';

/** 繰り返しの種類ごとに追加で指定できるオプション */
const TYPE_SPECIFIC_OPTIONS = ['weekdays', 'day', 'nth', 'holidays', 'until', 'count'] as const;
type TypeSpecificOption = (typeof TYPE_SPECIFIC_OPTIONS)[number];

const RECURRING_OPTIONS: TypeSpecificOption[] = ['holidays', 'until', 'count'];
const APPLICABLE_OPTIONS: Record<ScheduleType, ReadonlySet<TypeSpecificOption>> = {
	once: new Set(),
	daily: new Set(RECURRING_OPTIONS),
	weekdays: new Set(RECURRING_OPTIONS),
	weekly: new Set([...RECURRING_OPTIONS, 'weekdays']),
	biweekly: new Set([...RECURRING_OPTIONS, 'weekdays']),
	monthly_day: new Set([...RECURRING_OPTIONS, 'day']),
	monthly_last: new Set(RECURRING_OPTIONS),
	monthly_nth_weekday: new Set([...RECURRING_OPTIONS, 'weekdays', 'nth']),
};

/** 日付の指定 (once は実行日、繰り返しは開始日) */
type DateSpec = { kind: 'none' } | { kind: 'partial'; value: PartialDate } | { kind: 'fixed'; value: string };

interface Draft {
	type: ScheduleType;
	time: number;
	date: DateSpec;
	weekdaysMask: number | null;
	day: number | null;
	nth: number | null;
	holidays: HolidayPolicy;
	preNotify: number | null;
	nagInterval: number | null;
	nagMax: number | null;
	until: string | null;
	count: number | null;
}

function fail<T>(message: string): OptionResult<T> {
	return { ok: false, message };
}

function isClearWord(value: string): boolean {
	return CLEAR_WORDS.has(value.normalize('NFKC').trim().toLowerCase());
}

function todayOf(nowMs: number): string {
	return utcMsToJst(nowMs).date;
}

/** 年の省略を「今日以降で最も近い日付」として解決する */
function resolveDateFromToday(partial: PartialDate, nowMs: number): string | null {
	if (partial.year !== null) {
		return formatDate({ year: partial.year, month: partial.month, day: partial.day });
	}
	// 24:00 (= 翌日 0:00) が現在より後なら、その日は今日以降
	return resolveDate(partial, 24 * 60, nowMs);
}

function parseRepeat(value: string): ScheduleType | null {
	return (SCHEDULE_TYPES as readonly string[]).includes(value) ? (value as ScheduleType) : null;
}

function parseHolidays(value: string): HolidayPolicy | null {
	return (HOLIDAY_POLICIES as readonly string[]).includes(value) ? (value as HolidayPolicy) : null;
}

function countBits(mask: number): number {
	let count = 0;
	for (let bits = mask; bits !== 0; bits &= bits - 1) {
		count++;
	}
	return count;
}

/** 明示的に指定された、繰り返しの種類に依存するオプションのうち、適用できないもの */
function inapplicableOptions(type: ScheduleType, opts: ScheduleOptionValues): TypeSpecificOption[] {
	const applicable = APPLICABLE_OPTIONS[type];
	return TYPE_SPECIFIC_OPTIONS.filter((name) => {
		const value = opts[name];
		if (value === undefined || applicable.has(name)) {
			return false;
		}
		// 消去の指定 (until:なし / count:0) と、once での holidays:通知する は何もしないので許容する
		if (name === 'until' && typeof value === 'string' && isClearWord(value)) {
			return false;
		}
		if (name === 'count' && value === 0) {
			return false;
		}
		if (name === 'holidays' && value === 'notify') {
			return false;
		}
		return true;
	});
}

/** 指定されたオプションを下書きに反映する (形式の検証も行う) */
function applyOptions(draft: Draft, opts: ScheduleOptionValues, nowMs: number): OptionResult<Draft> {
	const next = { ...draft };

	if (opts.holidays !== undefined) {
		const policy = parseHolidays(opts.holidays);
		if (!policy) {
			return fail('holidays の指定が正しくありません。');
		}
		if (next.type === 'once' && policy !== 'notify') {
			return fail(ONCE_HOLIDAY_ERROR);
		}
		next.holidays = policy;
	}

	const inapplicable = inapplicableOptions(next.type, opts);
	if (inapplicable.length > 0) {
		return fail(
			`繰り返し「${REPEAT_LABELS[next.type]}」では次のオプションは指定できません: ${inapplicable.join(', ')}`,
		);
	}

	if (opts.time !== undefined) {
		const time = parseTime(opts.time);
		if (time === null) {
			return fail('time は `HH:MM` の形式で指定してください（例: 09:00）。');
		}
		next.time = time;
	}

	if (opts.date !== undefined) {
		const partial = parsePartialDate(opts.date);
		if (!partial) {
			return fail('date は `YYYY-MM-DD` または `M/D` の形式で指定してください（例: 2026-12-01）。');
		}
		next.date = { kind: 'partial', value: partial };
	}

	if (opts.weekdays !== undefined) {
		const mask = parseWeekdays(opts.weekdays);
		if (mask === null) {
			return fail('weekdays は `月水金` のように曜日を並べて指定してください。');
		}
		next.weekdaysMask = mask;
	}

	if (opts.day !== undefined) {
		next.day = opts.day;
	}
	if (opts.nth !== undefined) {
		next.nth = opts.nth;
	}

	if (opts.pre_notify !== undefined) {
		next.preNotify = opts.pre_notify > 0 ? opts.pre_notify : null;
	}

	if (opts.nag_interval !== undefined) {
		if (opts.nag_interval > 0 && opts.nag_interval < MIN_NAG_INTERVAL) {
			return fail(`nag_interval（再通知の間隔）は ${MIN_NAG_INTERVAL} 分以上で指定してください。`);
		}
		if (opts.nag_interval > 0) {
			next.nagInterval = opts.nag_interval;
			next.nagMax ??= DEFAULT_NAG_MAX;
		} else {
			next.nagInterval = null;
			next.nagMax = null;
		}
	}
	if (opts.nag_max !== undefined) {
		if (next.nagInterval === null) {
			return fail('nag_max は nag_interval（再通知の間隔）と一緒に指定してください。');
		}
		next.nagMax = opts.nag_max;
	}

	if (opts.until !== undefined) {
		if (isClearWord(opts.until)) {
			next.until = null;
		} else {
			const partial = parsePartialDate(opts.until);
			const until = partial ? resolveDateFromToday(partial, nowMs) : null;
			if (!until) {
				return fail('until は `YYYY-MM-DD` または `M/D` の形式で指定してください（例: 2026-12-31）。');
			}
			if (until < todayOf(nowMs)) {
				return fail('until（終了日）には今日以降の日付を指定してください。');
			}
			next.until = until;
		}
	}

	if (opts.count !== undefined) {
		next.count = opts.count > 0 ? opts.count : null;
	}

	return { ok: true, value: next };
}

/** 下書きを検証し、DB の列に変換する */
function finalize(draft: Draft, nowMs: number): OptionResult<ScheduleFields> {
	const fields: ScheduleFields = {
		schedule_type: draft.type,
		time_of_day: draft.time,
		once_at: null,
		weekdays_mask: null,
		day_of_month: null,
		nth_week: null,
		start_date: null,
		holiday_policy: draft.holidays,
		pre_notify_minutes: draft.preNotify,
		nag_interval_minutes: draft.nagInterval,
		nag_max_count: draft.nagInterval !== null ? (draft.nagMax ?? DEFAULT_NAG_MAX) : null,
		end_date: null,
		remaining_count: null,
	};

	if (draft.type === 'once') {
		if (draft.holidays !== 'notify') {
			return fail(ONCE_HOLIDAY_ERROR);
		}
		let onceAt: number;
		if (draft.date.kind === 'none') {
			// 日付を省略した場合は、指定時刻が次に来る日時
			const todayAt = jstToUtcMs(todayOf(nowMs), draft.time);
			onceAt = todayAt > nowMs ? todayAt : todayAt + DAY_MS;
		} else {
			const date =
				draft.date.kind === 'fixed' ? draft.date.value : resolveDate(draft.date.value, draft.time, nowMs);
			if (!date) {
				return fail('指定した日付が見つかりません。date を確認してください。');
			}
			onceAt = jstToUtcMs(date, draft.time);
		}
		if (onceAt <= nowMs) {
			return fail('指定した日時はすでに過ぎています。未来の日時を指定してください。');
		}
		fields.once_at = onceAt;
		return { ok: true, value: fields };
	}

	let startDate: string;
	if (draft.date.kind === 'none') {
		startDate = todayOf(nowMs);
	} else if (draft.date.kind === 'fixed') {
		startDate = draft.date.value;
	} else {
		const resolved = resolveDateFromToday(draft.date.value, nowMs);
		if (!resolved) {
			return fail('指定した日付が見つかりません。date を確認してください。');
		}
		startDate = resolved;
	}
	fields.start_date = startDate;

	const label = REPEAT_LABELS[draft.type];
	switch (draft.type) {
		case 'weekly':
		case 'biweekly':
			if (draft.weekdaysMask === null) {
				return fail(`繰り返し「${label}」では weekdays（曜日）を指定してください（例: 月水金）。`);
			}
			fields.weekdays_mask = draft.weekdaysMask;
			break;
		case 'monthly_day':
			if (draft.day === null) {
				return fail(`繰り返し「${label}」では day（日付 1〜31）を指定してください。`);
			}
			fields.day_of_month = draft.day;
			break;
		case 'monthly_nth_weekday':
			if (draft.weekdaysMask === null || countBits(draft.weekdaysMask) !== 1) {
				return fail(`繰り返し「${label}」では weekdays に曜日を 1 つだけ指定してください（例: 火）。`);
			}
			if (draft.nth === null) {
				return fail(`繰り返し「${label}」では nth（第何週か。5 は最終週）を指定してください。`);
			}
			fields.weekdays_mask = draft.weekdaysMask;
			fields.nth_week = draft.nth;
			break;
		default:
			break;
	}

	if (draft.until !== null && draft.until < startDate) {
		return fail('until（終了日）が開始日より前になっています。');
	}
	fields.end_date = draft.until;
	fields.remaining_count = draft.count;
	return { ok: true, value: fields };
}

/** `/remind add` のオプションからスケジュールを作る */
export function buildScheduleForAdd(opts: ScheduleOptionValues, nowMs: number): OptionResult<ScheduleFields> {
	const type = parseRepeat(opts.repeat ?? 'once');
	if (!type) {
		return fail('repeat の指定が正しくありません。');
	}
	const draft: Draft = {
		type,
		time: 0,
		date: { kind: 'none' },
		weekdaysMask: null,
		day: null,
		nth: null,
		holidays: 'notify',
		preNotify: null,
		nagInterval: null,
		nagMax: null,
		until: null,
		count: null,
	};
	if (opts.time === undefined) {
		return fail('time を指定してください。');
	}
	const applied = applyOptions(draft, opts, nowMs);
	return applied.ok ? finalize(applied.value, nowMs) : applied;
}

/**
 * `/remind edit` のオプションを現在の内容に重ねる。
 * - repeat を変えた場合、新しい繰り返しに当てはまらない項目は黙って消す (明示的に指定した場合はエラー)
 * - 祝日の扱いは自動では戻さない (once に変えるなら holidays:通知する の同時指定が必要)
 * - once で time だけを変えた場合は、現在の実行日を保つ
 */
export function buildScheduleForEdit(
	current: ScheduleFields,
	opts: ScheduleOptionValues,
	nowMs: number,
): OptionResult<ScheduleFields> {
	const type = opts.repeat !== undefined ? parseRepeat(opts.repeat) : current.schedule_type;
	if (!type) {
		return fail('repeat の指定が正しくありません。');
	}
	const applicable = APPLICABLE_OPTIONS[type];
	const wasOnce = current.schedule_type === 'once';
	const isOnce = type === 'once';

	let date: DateSpec = { kind: 'none' };
	if (wasOnce === isOnce) {
		if (wasOnce && current.once_at !== null) {
			date = { kind: 'fixed', value: utcMsToJst(current.once_at).date };
		} else if (!wasOnce && current.start_date !== null) {
			date = { kind: 'fixed', value: current.start_date };
		}
	}

	const draft: Draft = {
		type,
		time: current.time_of_day,
		date,
		weekdaysMask: applicable.has('weekdays') ? current.weekdays_mask : null,
		day: applicable.has('day') ? current.day_of_month : null,
		nth: applicable.has('nth') ? current.nth_week : null,
		holidays: current.holiday_policy,
		preNotify: current.pre_notify_minutes,
		nagInterval: current.nag_interval_minutes,
		nagMax: current.nag_max_count,
		until: applicable.has('until') ? current.end_date : null,
		count: applicable.has('count') ? current.remaining_count : null,
	};
	const applied = applyOptions(draft, opts, nowMs);
	return applied.ok ? finalize(applied.value, nowMs) : applied;
}

export interface RelativeOptionValues {
	minutes?: number;
	hours?: number;
	days?: number;
}

/** `/remind in` の相対時刻から 1 回のみのスケジュールを作る */
export function buildScheduleForRelative(opts: RelativeOptionValues, nowMs: number): OptionResult<ScheduleFields> {
	const total = (opts.minutes ?? 0) + (opts.hours ?? 0) * 60 + (opts.days ?? 0) * 24 * 60;
	if (total <= 0) {
		return fail('minutes / hours / days のいずれかで 1 分以上を指定してください。');
	}
	if (total > MAX_RELATIVE_MINUTES) {
		return fail('365 日以内で指定してください。');
	}
	// 分単位の精度のため、秒以下は切り捨てる
	const onceAt = Math.floor((nowMs + total * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
	return {
		ok: true,
		value: {
			schedule_type: 'once',
			time_of_day: utcMsToJst(onceAt).minutesOfDay,
			once_at: onceAt,
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
		},
	};
}

export interface ResolvedMention {
	mention: MentionSpec;
	/** ロールの場合のみ、そのロールが誰でもメンションできるか */
	roleMentionable: boolean | undefined;
}

/**
 * mentionable オプションの値をメンション先に変換する。
 * 省略時と登録者本人を選んだ場合は 'self' にする。
 */
export function resolveMentionOption(
	mentionId: string | undefined,
	ownerId: string,
	resolved: Pick<APIInteractionDataResolved, 'users' | 'roles'> | undefined,
): OptionResult<ResolvedMention> {
	if (mentionId === undefined || mentionId === ownerId) {
		return { ok: true, value: { mention: { type: 'self', targetId: null }, roleMentionable: undefined } };
	}
	const role = resolved?.roles?.[mentionId];
	if (role) {
		return {
			ok: true,
			value: { mention: { type: 'role', targetId: mentionId }, roleMentionable: role.mentionable },
		};
	}
	if (resolved?.users?.[mentionId]) {
		return { ok: true, value: { mention: { type: 'user', targetId: mentionId }, roleMentionable: undefined } };
	}
	return fail('メンション先を確認できませんでした。もう一度指定してください。');
}

/** オプションの値が 1 つでも指定されているか */
export function hasAnyValue(values: Record<string, unknown>): boolean {
	return Object.values(values).some((value) => value !== undefined);
}
