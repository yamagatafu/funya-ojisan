import {
	addDays,
	daysInMonth,
	jstToUtcMs,
	MAX_SUPPORTED_YEAR,
	parseDateString,
	toEpochDay,
	utcMsToJst,
	weekdayOf,
} from './date.ts';
import { isJapaneseHoliday, nextBusinessDay } from './holidays.ts';

export const SCHEDULE_TYPES = [
	'once',
	'daily',
	'weekdays',
	'weekly',
	'biweekly',
	'monthly_day',
	'monthly_last',
	'monthly_nth_weekday',
] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export const HOLIDAY_POLICIES = ['notify', 'skip', 'shift'] as const;
export type HolidayPolicy = (typeof HOLIDAY_POLICIES)[number];

/** 第 n 週の指定で「最終週」を表す値 */
export const LAST_WEEK = 5;

export interface Schedule {
	type: ScheduleType;
	/** 0:00 からの経過分 (JST) */
	timeOfDay: number;
	/** once の実行日時 (UTC ms) */
	onceAt: number | null;
	/** bit0=日 ... bit6=土 */
	weekdaysMask: number | null;
	/** 1-31 */
	dayOfMonth: number | null;
	/** 1-5 (5 = 最終週) */
	nthWeek: number | null;
	/** 開始日 (YYYY-MM-DD, JST)。隔週の起点週を兼ねる。これより前の予定は作らない */
	startDate: string | null;
	holidayPolicy: HolidayPolicy;
	/** 終了日 (YYYY-MM-DD, JST, 当日を含む)。元の予定日で判定する */
	endDate: string | null;
	/** 残り回数 (null = 無制限) */
	remainingCount: number | null;
}

export interface Occurrence {
	/** 実際の通知日時 (振替後, UTC ms) */
	runAt: number;
	/** 元の予定日 (振替前, YYYY-MM-DD, JST) */
	originalDate: string;
}

/** 振替によって afterMs より前の予定が後ろにずれ込む場合に備え、さかのぼって調べる日数 */
const LOOKBACK_DAYS = 14;
/** 次回を探す最大日数 */
const LOOKAHEAD_DAYS = 800;

/** 月曜始まりの週番号 */
function mondayWeekIndex(date: string): number {
	// 1970-01-01 (木) を含む週の月曜は 1969-12-29 (epochDay -3)
	return Math.floor((toEpochDay(date) + 3) / 7);
}

function hasWeekday(mask: number | null, weekday: number): boolean {
	return mask !== null && (mask & (1 << weekday)) !== 0;
}

/** 元の予定日がパターンに一致するか */
export function matchesPattern(schedule: Schedule, date: string): boolean {
	const weekday = weekdayOf(date);
	const { year, month, day } = parseDateString(date);
	const lastDay = daysInMonth(year, month);

	switch (schedule.type) {
		case 'once':
			return false;
		case 'daily':
			return true;
		case 'weekdays':
			return weekday >= 1 && weekday <= 5;
		case 'weekly':
			return hasWeekday(schedule.weekdaysMask, weekday);
		case 'biweekly': {
			if (!hasWeekday(schedule.weekdaysMask, weekday) || !schedule.startDate) {
				return false;
			}
			const diff = mondayWeekIndex(date) - mondayWeekIndex(schedule.startDate);
			return ((diff % 2) + 2) % 2 === 0;
		}
		case 'monthly_day':
			return schedule.dayOfMonth !== null && day === Math.min(schedule.dayOfMonth, lastDay);
		case 'monthly_last':
			return day === lastDay;
		case 'monthly_nth_weekday': {
			if (!hasWeekday(schedule.weekdaysMask, weekday) || schedule.nthWeek === null) {
				return false;
			}
			if (schedule.nthWeek === LAST_WEEK) {
				return day + 7 > lastDay;
			}
			return Math.ceil(day / 7) === schedule.nthWeek;
		}
	}
}

/**
 * afterMs より後の最初の通知を求める。該当がなければ null。
 *
 * - holidayPolicy=skip: 祝日に当たる回は飛ばす
 * - holidayPolicy=shift: 祝日に当たる回を次の平日に振り替える。振替先に通常の予定がある場合は 1 回にまとめる
 *   (振替によって後の予定日の通知より遅くなることがあるため、候補のうち最も早いものを返す)
 */
export function computeNextOccurrence(schedule: Schedule, afterMs: number): Occurrence | null {
	if (schedule.remainingCount !== null && schedule.remainingCount <= 0) {
		return null;
	}

	if (schedule.type === 'once') {
		if (schedule.onceAt === null || schedule.onceAt <= afterMs) {
			return null;
		}
		const originalDate = utcMsToJst(schedule.onceAt).date;
		if (schedule.endDate && originalDate > schedule.endDate) {
			return null;
		}
		return { runAt: schedule.onceAt, originalDate };
	}

	const afterDate = utcMsToJst(afterMs).date;
	let date = addDays(afterDate, -LOOKBACK_DAYS);
	if (schedule.startDate && date < schedule.startDate) {
		date = schedule.startDate;
	}

	let best: Occurrence | null = null;
	let bestEffectiveDate: string | null = null;

	for (let i = 0; i < LOOKAHEAD_DAYS + LOOKBACK_DAYS; i++, date = addDays(date, 1)) {
		// 振替先は元の予定日以降になるため、最良候補の通知日より後の予定日からは、より早い通知は生まれない
		if (bestEffectiveDate !== null && date > bestEffectiveDate) {
			break;
		}
		if (schedule.endDate && date > schedule.endDate) {
			break;
		}
		// 祝日の計算式が有効な範囲を超えると祝日を判定できないため、祝日を考慮する予定はそこで終える
		if (schedule.holidayPolicy !== 'notify' && Number(date.slice(0, 4)) > MAX_SUPPORTED_YEAR) {
			break;
		}
		if (!matchesPattern(schedule, date)) {
			continue;
		}

		let effectiveDate = date;
		if (schedule.holidayPolicy !== 'notify' && isJapaneseHoliday(date)) {
			if (schedule.holidayPolicy === 'skip') {
				continue;
			}
			effectiveDate = nextBusinessDay(date);
		}

		const runAt = jstToUtcMs(effectiveDate, schedule.timeOfDay);
		if (runAt > afterMs && (best === null || runAt < best.runAt)) {
			best = { runAt, originalDate: date };
			bestEffectiveDate = effectiveDate;
		}
	}

	return best;
}
