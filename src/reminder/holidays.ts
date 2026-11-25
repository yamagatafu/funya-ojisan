/**
 * 日本の祝日判定 (「国民の祝日に関する法律」に基づく計算)。
 *
 * - 外部データに依存せず、現行法の規則から計算する
 * - 春分・秋分の日は近似式によるため 1980〜2099 年の範囲で有効
 * - 2020・2021 年の東京オリンピックに伴う特例など、過去の一時的な移動には対応しない
 *   (リマインダは未来の日付のみを扱うため)
 *
 * 祝日法が改正された場合 (祝日の新設・移動など) は、このファイルの修正が必要。
 */

import { addDays, daysInMonth, formatDate, weekdayOf } from './date.ts';

/** 指定月の第 n 月曜日 */
function nthMonday(year: number, month: number, nth: number): string {
	const first = formatDate({ year, month, day: 1 });
	const offset = (1 - weekdayOf(first) + 7) % 7;
	return formatDate({ year, month, day: 1 + offset + (nth - 1) * 7 });
}

function vernalEquinoxDay(year: number): number {
	return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnalEquinoxDay(year: number): number {
	return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 「国民の祝日」そのもの (振替休日・国民の休日を含まない) */
function baseHolidays(year: number): Map<string, string> {
	const d = (month: number, day: number) => formatDate({ year, month, day });
	return new Map<string, string>([
		[d(1, 1), '元日'],
		[nthMonday(year, 1, 2), '成人の日'],
		[d(2, 11), '建国記念の日'],
		[d(2, 23), '天皇誕生日'],
		[d(3, vernalEquinoxDay(year)), '春分の日'],
		[d(4, 29), '昭和の日'],
		[d(5, 3), '憲法記念日'],
		[d(5, 4), 'みどりの日'],
		[d(5, 5), 'こどもの日'],
		[nthMonday(year, 7, 3), '海の日'],
		[d(8, 11), '山の日'],
		[nthMonday(year, 9, 3), '敬老の日'],
		[d(9, autumnalEquinoxDay(year)), '秋分の日'],
		[nthMonday(year, 10, 2), 'スポーツの日'],
		[d(11, 3), '文化の日'],
		[d(11, 23), '勤労感謝の日'],
	]);
}

const cache = new Map<number, Map<string, string>>();

function holidaysOfYear(year: number): Map<string, string> {
	const cached = cache.get(year);
	if (cached) {
		return cached;
	}

	const base = baseHolidays(year);
	const result = new Map(base);

	// 国民の休日: 前日と翌日が「国民の祝日」である祝日でない日
	for (let month = 1; month <= 12; month++) {
		for (let day = 1; day <= daysInMonth(year, month); day++) {
			const date = formatDate({ year, month, day });
			if (!base.has(date) && base.has(addDays(date, -1)) && base.has(addDays(date, 1))) {
				result.set(date, '国民の休日');
			}
		}
	}

	// 振替休日: 「国民の祝日」が日曜日に当たるとき、その日後の最も近い祝日でない日
	for (const date of base.keys()) {
		if (weekdayOf(date) !== 0) {
			continue;
		}
		let substitute = addDays(date, 1);
		while (result.has(substitute)) {
			substitute = addDays(substitute, 1);
		}
		result.set(substitute, '振替休日');
	}

	cache.set(year, result);
	return result;
}

/** 祝日名を返す。祝日でなければ null */
export function getJapaneseHolidayName(date: string): string | null {
	const year = Number(date.slice(0, 4));
	return holidaysOfYear(year).get(date) ?? null;
}

export function isJapaneseHoliday(date: string): boolean {
	return getJapaneseHolidayName(date) !== null;
}

/** 土日・祝日のいずれでもない日 */
export function isBusinessDay(date: string): boolean {
	const weekday = weekdayOf(date);
	return weekday !== 0 && weekday !== 6 && !isJapaneseHoliday(date);
}

/** 指定日より後の最初の平日 */
export function nextBusinessDay(date: string): string {
	let candidate = addDays(date, 1);
	while (!isBusinessDay(candidate)) {
		candidate = addDays(candidate, 1);
	}
	return candidate;
}
