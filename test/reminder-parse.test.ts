import { describe, expect, it } from 'vitest';
import { formatJstDateTime, jstToUtcMs } from '../src/reminder/date.ts';
import {
	MAX_SUPPORTED_MS,
	parseDate,
	parseDuration,
	parseTime,
	parseWeekdays,
	parseWhen,
} from '../src/reminder/parse.ts';

const NOW = jstToUtcMs('2026-11-25', 10 * 60); // 2026-11-25 (水) 10:00 JST

describe('parseTime', () => {
	it('accepts HH:MM, H:MM, HHMM and full-width input', () => {
		expect(parseTime('09:05')).toBe(9 * 60 + 5);
		expect(parseTime('9:05')).toBe(9 * 60 + 5);
		expect(parseTime('2359')).toBe(23 * 60 + 59);
		expect(parseTime('０９：３０')).toBe(9 * 60 + 30);
	});

	it('rejects invalid times', () => {
		expect(parseTime('24:00')).toBeNull();
		expect(parseTime('9:60')).toBeNull();
		expect(parseTime('nine')).toBeNull();
	});
});

describe('parseDate', () => {
	it('accepts full and short dates', () => {
		expect(parseDate('2026-12-01', NOW)).toBe('2026-12-01');
		expect(parseDate('2027/1/5', NOW)).toBe('2027-01-05');
		expect(parseDate('12/24', NOW)).toBe('2026-12-24');
	});

	it('rejects non-existent dates', () => {
		expect(parseDate('2026-02-29', NOW)).toBeNull();
		expect(parseDate('13/1', NOW)).toBeNull();
		// 祝日の計算式が有効な範囲 (2099 年) を超える年は受け付けない
		expect(parseDate('2099-12-31', NOW)).toBe('2099-12-31');
		expect(parseDate('2100-01-01', NOW)).toBeNull();
		expect(parseDate('9999-01-01', NOW)).toBeNull();
	});
});

describe('parseWeekdays', () => {
	it('accepts several notations', () => {
		const monWedFri = (1 << 1) | (1 << 3) | (1 << 5);
		expect(parseWeekdays('月水金')).toBe(monWedFri);
		expect(parseWeekdays('月,水,金')).toBe(monWedFri);
		expect(parseWeekdays('月曜日 水曜 金')).toBe(monWedFri);
		expect(parseWeekdays('日')).toBe(1);
	});

	it('rejects unknown characters and empty input', () => {
		expect(parseWeekdays('月X')).toBeNull();
		expect(parseWeekdays('')).toBeNull();
	});
});

describe('parseDuration', () => {
	it('accepts Japanese and short units', () => {
		expect(parseDuration('30分')).toBe(30);
		expect(parseDuration('2時間')).toBe(120);
		expect(parseDuration('1時間30分')).toBe(90);
		expect(parseDuration('1h30m')).toBe(90);
		expect(parseDuration('1日')).toBe(1440);
	});

	it('rejects invalid durations', () => {
		expect(parseDuration('30')).toBeNull();
		expect(parseDuration('0分')).toBeNull();
		expect(parseDuration('30分後')).toBeNull();
	});

	it('rejects durations that are too large to represent exactly', () => {
		expect(parseDuration(`${'9'.repeat(400)}分`)).toBeNull();
		expect(parseDuration('99999999999999999日')).toBeNull();
	});
});

describe('parseWhen', () => {
	const when = (input: string) => {
		const ms = parseWhen(input, NOW);
		return ms === null ? null : formatJstDateTime(ms);
	};

	it('accepts relative durations', () => {
		expect(when('30分')).toBe('2026-11-25 10:30');
	});

	it('accepts a time today or tomorrow', () => {
		expect(when('18:00')).toBe('2026-11-25 18:00');
		expect(when('09:00')).toBe('2026-11-26 09:00');
	});

	it('accepts a date and time, inferring the next year when omitted', () => {
		expect(when('2026-12-01 09:00')).toBe('2026-12-01 09:00');
		expect(when('1/5 09:00')).toBe('2027-01-05 09:00');
	});

	it('rejects unknown input', () => {
		expect(when('あした')).toBeNull();
	});

	it('rejects relative durations beyond the representable date range', () => {
		expect(when('1000000000日')).toBeNull();
		expect(when(`${'9'.repeat(400)}分`)).toBeNull();
		expect(when('36500日')).toBe('2126-11-01 10:00');
	});

	it('accepts relative durations up to the boundary that can still be displayed in JST', () => {
		const maxMinutes = Math.floor((MAX_SUPPORTED_MS - NOW) / 60_000);
		const atBoundary = parseWhen(`${maxMinutes}分`, NOW);
		expect(atBoundary).not.toBeNull();
		expect(formatJstDateTime(atBoundary!)).toMatch(/^\d{4,}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(parseWhen(`${maxMinutes + 1}分`, NOW)).toBeNull();
		// Date の上限ちょうど (JST 表示では範囲外になる値) は受け付けない
		expect(parseWhen(`${Math.floor((8.64e15 - NOW) / 60_000)}分`, NOW)).toBeNull();
	});
});
