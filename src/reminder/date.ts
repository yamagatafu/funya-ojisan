/**
 * JST (UTC+9, 夏時間なし) を前提とした日付ユーティリティ。
 * 日付は `YYYY-MM-DD` 形式の文字列 (JST の暦日) で扱い、日時は UTC の Unix ms で扱う。
 */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 入力として受け付ける最後の年 (祝日の計算式が有効な範囲。holidays.ts を参照) */
export const MAX_SUPPORTED_YEAR = 2099;

export interface CivilDate {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

export function formatDate(date: CivilDate): string {
	return `${String(date.year).padStart(4, '0')}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function parseDateString(value: string): CivilDate {
	const [year, month, day] = value.split('-').map(Number);
	return { year: year!, month: month!, day: day! };
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidCivilDate(date: CivilDate): boolean {
	return (
		Number.isInteger(date.year) &&
		Number.isInteger(date.month) &&
		Number.isInteger(date.day) &&
		date.year >= 1970 &&
		date.year <= MAX_SUPPORTED_YEAR &&
		date.month >= 1 &&
		date.month <= 12 &&
		date.day >= 1 &&
		date.day <= daysInMonth(date.year, date.month)
	);
}

/** 1970-01-01 からの経過日数 */
export function toEpochDay(date: string): number {
	const { year, month, day } = parseDateString(date);
	return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function fromEpochDay(epochDay: number): string {
	const d = new Date(epochDay * DAY_MS);
	return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

export function addDays(date: string, days: number): string {
	return fromEpochDay(toEpochDay(date) + days);
}

/** 0=日 ... 6=土 */
export function weekdayOf(date: string): number {
	// 1970-01-01 は木曜日 (4)
	return (((toEpochDay(date) + 4) % 7) + 7) % 7;
}

/** JST の暦日と 0:00 からの経過分から UTC ms を求める */
export function jstToUtcMs(date: string, minutesOfDay: number): number {
	const { year, month, day } = parseDateString(date);
	return Date.UTC(year, month - 1, day) + minutesOfDay * MINUTE_MS - JST_OFFSET_MS;
}

/** UTC ms を JST の暦日と 0:00 からの経過分に変換する */
export function utcMsToJst(ms: number): { date: string; minutesOfDay: number } {
	const shifted = new Date(ms + JST_OFFSET_MS);
	return {
		date: formatDate({
			year: shifted.getUTCFullYear(),
			month: shifted.getUTCMonth() + 1,
			day: shifted.getUTCDate(),
		}),
		minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
	};
}

export function formatMinutesOfDay(minutesOfDay: number): string {
	return `${pad2(Math.floor(minutesOfDay / 60))}:${pad2(minutesOfDay % 60)}`;
}

/** UTC ms を JST の `YYYY-MM-DD HH:MM` で表す */
export function formatJstDateTime(ms: number): string {
	const { date, minutesOfDay } = utcMsToJst(ms);
	return `${date} ${formatMinutesOfDay(minutesOfDay)}`;
}

/** UTC ms を JST の `HH:MM` で表す */
export function formatJstTime(ms: number): string {
	return formatMinutesOfDay(utcMsToJst(ms).minutesOfDay);
}
