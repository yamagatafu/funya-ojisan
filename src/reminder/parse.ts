import { formatDate, isValidCivilDate, JST_OFFSET_MS, jstToUtcMs, MINUTE_MS, utcMsToJst } from './date.ts';

/** 全角英数字・記号を半角に寄せ、前後の空白を除く */
function normalize(input: string): string {
	return input.normalize('NFKC').trim();
}

/** `HH:MM` / `H:MM` / `HHMM` を 0:00 からの経過分に変換する */
export function parseTime(input: string): number | null {
	const value = normalize(input);
	const match = /^(\d{1,2}):(\d{2})$/.exec(value) ?? /^(\d{2})(\d{2})$/.exec(value);
	if (!match) {
		return null;
	}
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) {
		return null;
	}
	return hours * 60 + minutes;
}

export interface PartialDate {
	/** 省略時は null */
	year: number | null;
	month: number;
	day: number;
}

/** `YYYY-MM-DD` / `YYYY/M/D` / `M/D` / `M-D` を解釈する */
export function parsePartialDate(input: string): PartialDate | null {
	const value = normalize(input);
	const full = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
	if (full) {
		const date = { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
		return isValidCivilDate(date) ? date : null;
	}
	const short = /^(\d{1,2})[-/](\d{1,2})$/.exec(value);
	if (short) {
		const month = Number(short[1]);
		const day = Number(short[2]);
		// 2/29 を許容するため、うるう年で検証する
		return isValidCivilDate({ year: 2024, month, day }) ? { year: null, month, day } : null;
	}
	return null;
}

/**
 * 年を省略した日付を、基準時刻以降で最も近い日付に解決する。
 * 年が指定されていればそのまま返す。2/29 のように存在しない年はスキップする。
 */
export function resolveDate(partial: PartialDate, minutesOfDay: number, nowMs: number): string | null {
	if (partial.year !== null) {
		return formatDate({ year: partial.year, month: partial.month, day: partial.day });
	}
	const currentYear = Number(utcMsToJst(nowMs).date.slice(0, 4));
	for (let year = currentYear; year <= currentYear + 8; year++) {
		const civil = { year, month: partial.month, day: partial.day };
		if (!isValidCivilDate(civil)) {
			continue;
		}
		const date = formatDate(civil);
		if (jstToUtcMs(date, minutesOfDay) > nowMs) {
			return date;
		}
	}
	return null;
}

/** `YYYY-MM-DD` 形式などの日付を年込みで解釈する (年省略時は今年) */
export function parseDate(input: string, nowMs: number): string | null {
	const partial = parsePartialDate(input);
	if (!partial) {
		return null;
	}
	const year = partial.year ?? Number(utcMsToJst(nowMs).date.slice(0, 4));
	const civil = { year, month: partial.month, day: partial.day };
	return isValidCivilDate(civil) ? formatDate(civil) : null;
}

const WEEKDAY_CHARS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** `月水金` / `月,水,金` / `月曜 水曜日` を曜日マスク (bit0=日 ... bit6=土) に変換する */
export function parseWeekdays(input: string): number | null {
	const value = normalize(input).replaceAll('曜日', '').replaceAll('曜', '');
	let mask = 0;
	for (const char of value) {
		if (/[\s,、・/]/.test(char)) {
			continue;
		}
		const index = WEEKDAY_CHARS.indexOf(char as (typeof WEEKDAY_CHARS)[number]);
		if (index < 0) {
			return null;
		}
		mask |= 1 << index;
	}
	return mask === 0 ? null : mask;
}

/**
 * 受け付ける最大の時刻 (UTC ms)。
 * `Date` の上限 (8.64e15) から、JST 表示時に加える 9 時間を差し引いた値 (JST に変換しても表示できる範囲)
 */
export const MAX_SUPPORTED_MS = 8.64e15 - JST_OFFSET_MS;

const DURATION_UNITS: Record<string, number> = {
	日: 24 * 60,
	d: 24 * 60,
	時間: 60,
	h: 60,
	分: 1,
	m: 1,
	min: 1,
};

/** `30分` / `2時間` / `1時間30分` / `1h30m` / `1日` を分に変換する */
export function parseDuration(input: string): number | null {
	const value = normalize(input).toLowerCase().replaceAll(/\s+/g, '');
	if (value.length === 0) {
		return null;
	}
	const pattern = /(\d+)(日|時間|分|min|d|h|m)/gy;
	let total = 0;
	let consumed = 0;
	for (const match of value.matchAll(pattern)) {
		total += Number(match[1]) * DURATION_UNITS[match[2]!]!;
		consumed += match[0].length;
	}
	// 桁数の多い入力で精度が落ちる・Infinity になる値は受け付けない
	if (consumed !== value.length || total <= 0 || !Number.isSafeInteger(total)) {
		return null;
	}
	return total;
}

/**
 * 「いつ」の入力を UTC ms に変換する (コンテキストメニュー用)。
 * - `30分` / `2時間` などの相対指定
 * - `HH:MM` (今日のその時刻。過ぎていれば明日)
 * - `YYYY-MM-DD HH:MM` / `M/D HH:MM` (年省略時は次に来るその日付)
 */
export function parseWhen(input: string, nowMs: number): number | null {
	const value = normalize(input);

	const duration = parseDuration(value);
	if (duration !== null) {
		const ms = nowMs + duration * MINUTE_MS;
		// JST に変換して表示できない日時 (極端に大きな相対指定) は受け付けない
		return Number.isFinite(ms) && ms <= MAX_SUPPORTED_MS ? ms : null;
	}

	const time = parseTime(value);
	if (time !== null) {
		const today = utcMsToJst(nowMs).date;
		const todayAt = jstToUtcMs(today, time);
		return todayAt > nowMs ? todayAt : todayAt + 24 * 60 * MINUTE_MS;
	}

	const parts = value.split(/\s+/);
	if (parts.length === 2) {
		const partial = parsePartialDate(parts[0]!);
		const minutes = parseTime(parts[1]!);
		if (partial && minutes !== null) {
			const date = resolveDate(partial, minutes, nowMs);
			return date ? jstToUtcMs(date, minutes) : null;
		}
	}

	return null;
}
