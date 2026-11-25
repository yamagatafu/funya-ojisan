import { describe, expect, it } from 'vitest';
import { addDays, formatJstDateTime, jstToUtcMs, weekdayOf } from '../src/reminder/date.ts';
import { describeSchedule } from '../src/reminder/format.ts';
import { getJapaneseHolidayName, isJapaneseHoliday, nextBusinessDay } from '../src/reminder/holidays.ts';
import { computeNextOccurrence, type Schedule } from '../src/reminder/schedule.ts';

const NINE = 9 * 60;
const MON = 1 << 1;
const TUE = 1 << 2;
const WED = 1 << 3;
const FRI = 1 << 5;

function at(date: string, time = '00:00'): number {
	const [h, m] = time.split(':').map(Number);
	return jstToUtcMs(date, h! * 60 + m!);
}

function schedule(overrides: Partial<Schedule>): Schedule {
	return {
		type: 'daily',
		timeOfDay: NINE,
		onceAt: null,
		weekdaysMask: null,
		dayOfMonth: null,
		nthWeek: null,
		startDate: null,
		holidayPolicy: 'notify',
		endDate: null,
		remainingCount: null,
		...overrides,
	};
}

function next(s: Schedule, after: number): string | null {
	const occurrence = computeNextOccurrence(s, after);
	return occurrence ? formatJstDateTime(occurrence.runAt) : null;
}

/** 連続して n 回分の通知日時を列挙する */
function sequence(s: Schedule, after: number, count: number): string[] {
	const result: string[] = [];
	let cursor = after;
	for (let i = 0; i < count; i++) {
		const occurrence = computeNextOccurrence(s, cursor);
		if (!occurrence) {
			break;
		}
		result.push(formatJstDateTime(occurrence.runAt));
		cursor = occurrence.runAt;
	}
	return result;
}

function holidaysOf(year: number): string[] {
	const result: string[] = [];
	for (let date = `${year}-01-01`; date.startsWith(String(year)); date = addDays(date, 1)) {
		if (isJapaneseHoliday(date)) {
			result.push(date.slice(5));
		}
	}
	return result;
}

describe('date utilities', () => {
	it('converts between JST and UTC', () => {
		expect(new Date(at('2026-11-25', '09:00')).toISOString()).toBe('2026-11-25T00:00:00.000Z');
		expect(formatJstDateTime(Date.parse('2026-11-25T15:30:00Z'))).toBe('2026-11-26 00:30');
		expect(weekdayOf('2026-11-25')).toBe(3);
	});
});

describe('Japanese holidays', () => {
	it('matches the official 2025 holiday list', () => {
		expect(holidaysOf(2025)).toEqual([
			'01-01',
			'01-13',
			'02-11',
			'02-23',
			'02-24',
			'03-20',
			'04-29',
			'05-03',
			'05-04',
			'05-05',
			'05-06',
			'07-21',
			'08-11',
			'09-15',
			'09-23',
			'10-13',
			'11-03',
			'11-23',
			'11-24',
		]);
	});

	it('matches the official 2026 holiday list (including 国民の休日 in September)', () => {
		expect(holidaysOf(2026)).toEqual([
			'01-01',
			'01-12',
			'02-11',
			'02-23',
			'03-20',
			'04-29',
			'05-03',
			'05-04',
			'05-05',
			'05-06',
			'07-20',
			'08-11',
			'09-21',
			'09-22',
			'09-23',
			'10-12',
			'11-03',
			'11-23',
		]);
		expect(getJapaneseHolidayName('2026-09-22')).toBe('国民の休日');
		expect(getJapaneseHolidayName('2026-05-06')).toBe('振替休日');
	});

	it('matches the official 2027 holiday list', () => {
		expect(holidaysOf(2027)).toEqual([
			'01-01',
			'01-11',
			'02-11',
			'02-23',
			'03-21',
			'03-22',
			'04-29',
			'05-03',
			'05-04',
			'05-05',
			'07-19',
			'08-11',
			'09-20',
			'09-23',
			'10-11',
			'11-03',
			'11-23',
		]);
	});

	it('finds the next business day across consecutive holidays', () => {
		expect(nextBusinessDay('2026-05-01')).toBe('2026-05-07');
		expect(nextBusinessDay('2026-09-18')).toBe('2026-09-24');
		expect(nextBusinessDay('2026-12-31')).toBe('2027-01-04');
	});
});

describe('computeNextOccurrence', () => {
	it('handles once', () => {
		const s = schedule({ type: 'once', onceAt: at('2026-12-01', '10:30') });
		expect(next(s, at('2026-11-25'))).toBe('2026-12-01 10:30');
		expect(next(s, at('2026-12-01', '10:30'))).toBeNull();
	});

	it('handles daily, including the same day when the time has not passed', () => {
		const s = schedule({ type: 'daily' });
		expect(next(s, at('2026-11-25', '08:59'))).toBe('2026-11-25 09:00');
		expect(next(s, at('2026-11-25', '09:00'))).toBe('2026-11-26 09:00');
	});

	it('handles weekdays', () => {
		const s = schedule({ type: 'weekdays' });
		expect(sequence(s, at('2026-11-27', '10:00'), 2)).toEqual(['2026-11-30 09:00', '2026-12-01 09:00']);
	});

	it('handles weekly with multiple weekdays', () => {
		const s = schedule({ type: 'weekly', weekdaysMask: MON | WED | FRI });
		expect(sequence(s, at('2026-11-25', '10:00'), 3)).toEqual([
			'2026-11-27 09:00',
			'2026-11-30 09:00',
			'2026-12-02 09:00',
		]);
	});

	it('handles biweekly anchored to the start week', () => {
		const s = schedule({ type: 'biweekly', weekdaysMask: MON | FRI, startDate: '2026-11-25' });
		expect(sequence(s, at('2026-11-25'), 4)).toEqual([
			'2026-11-27 09:00',
			'2026-12-07 09:00',
			'2026-12-11 09:00',
			'2026-12-21 09:00',
		]);
	});

	it('does not schedule before the start date', () => {
		const s = schedule({ type: 'daily', startDate: '2026-12-10' });
		expect(next(s, at('2026-11-25'))).toBe('2026-12-10 09:00');
	});

	it('clamps monthly day to the end of short months, including leap years', () => {
		const s = schedule({ type: 'monthly_day', dayOfMonth: 31 });
		expect(sequence(s, at('2027-12-31', '10:00'), 3)).toEqual([
			'2028-01-31 09:00',
			'2028-02-29 09:00',
			'2028-03-31 09:00',
		]);
	});

	it('crosses the year boundary', () => {
		const s = schedule({ type: 'monthly_day', dayOfMonth: 15 });
		expect(next(s, at('2026-12-20'))).toBe('2027-01-15 09:00');
	});

	it('handles monthly last day', () => {
		const s = schedule({ type: 'monthly_last' });
		expect(sequence(s, at('2027-01-31', '10:00'), 2)).toEqual(['2027-02-28 09:00', '2027-03-31 09:00']);
	});

	it('handles nth weekday and last weekday of the month', () => {
		const second = schedule({ type: 'monthly_nth_weekday', weekdaysMask: TUE, nthWeek: 2 });
		expect(sequence(second, at('2026-11-25'), 2)).toEqual(['2026-12-08 09:00', '2027-01-12 09:00']);

		const last = schedule({ type: 'monthly_nth_weekday', weekdaysMask: FRI, nthWeek: 5 });
		expect(sequence(last, at('2026-11-25'), 2)).toEqual(['2026-11-27 09:00', '2026-12-25 09:00']);
	});

	it('stops after the end date and when no count remains', () => {
		const ended = schedule({ type: 'daily', endDate: '2026-11-26' });
		expect(sequence(ended, at('2026-11-25'), 5)).toEqual(['2026-11-25 09:00', '2026-11-26 09:00']);

		const noCount = schedule({ type: 'daily', remainingCount: 0 });
		expect(next(noCount, at('2026-11-25'))).toBeNull();
	});

	it('respects the end date for once', () => {
		const s = schedule({ type: 'once', onceAt: at('2026-12-01', '09:00'), endDate: '2026-11-30' });
		expect(next(s, at('2026-11-25'))).toBeNull();
	});

	it('stops holiday-aware schedules after the last supported year', () => {
		const skip = schedule({ type: 'monthly_day', dayOfMonth: 1, holidayPolicy: 'skip' });
		expect(sequence(skip, at('2099-10-15'), 5)).toEqual(['2099-11-01 09:00', '2099-12-01 09:00']);
		// 祝日を考慮しない予定は続ける
		const notify = schedule({ type: 'monthly_day', dayOfMonth: 1 });
		expect(next(notify, at('2099-12-15'))).toBe('2100-01-01 09:00');
	});

	describe('holidayPolicy', () => {
		it('notify keeps holidays', () => {
			const s = schedule({ type: 'weekdays' });
			expect(next(s, at('2026-09-18', '10:00'))).toBe('2026-09-21 09:00');
		});

		it('skip drops holidays without shifting (Silver Week)', () => {
			const s = schedule({ type: 'weekdays', holidayPolicy: 'skip' });
			expect(sequence(s, at('2026-09-18', '10:00'), 2)).toEqual(['2026-09-24 09:00', '2026-09-25 09:00']);
		});

		it('skip across Golden Week and the New Year', () => {
			const s = schedule({ type: 'daily', holidayPolicy: 'skip' });
			expect(sequence(s, at('2026-05-02', '10:00'), 2)).toEqual(['2026-05-07 09:00', '2026-05-08 09:00']);
			expect(next(s, at('2026-12-31', '10:00'))).toBe('2027-01-02 09:00');
		});

		it('shift moves to the next business day across consecutive holidays', () => {
			const s = schedule({ type: 'weekly', weekdaysMask: MON, holidayPolicy: 'shift' });
			expect(next(s, at('2026-05-01'))).toBe('2026-05-07 09:00');
			expect(next(s, at('2026-09-18'))).toBe('2026-09-24 09:00');
		});

		it('shift merges with a regular occurrence on the same day', () => {
			const s = schedule({ type: 'weekdays', holidayPolicy: 'shift' });
			expect(sequence(s, at('2026-09-18', '10:00'), 3)).toEqual([
				'2026-09-24 09:00',
				'2026-09-25 09:00',
				'2026-09-28 09:00',
			]);
		});

		it('shift does not overtake regular weekend occurrences', () => {
			// 2027-01-01 (金) は元日 → 01-04 (月) に振替。間の土日は通常どおり通知する
			const s = schedule({ type: 'daily', holidayPolicy: 'shift' });
			expect(sequence(s, at('2026-12-31', '10:00'), 4)).toEqual([
				'2027-01-02 09:00',
				'2027-01-03 09:00',
				'2027-01-04 09:00',
				'2027-01-05 09:00',
			]);
		});

		it('shift keeps weekends that are not holidays', () => {
			const s = schedule({ type: 'weekly', weekdaysMask: 1 << 6, holidayPolicy: 'shift' });
			expect(next(s, at('2026-11-25'))).toBe('2026-11-28 09:00');
		});

		it('shift finds an occurrence whose original date is before afterMs', () => {
			const s = schedule({ type: 'weekly', weekdaysMask: MON, holidayPolicy: 'shift' });
			const occurrence = computeNextOccurrence(s, at('2026-09-22', '12:00'));
			expect(occurrence && formatJstDateTime(occurrence.runAt)).toBe('2026-09-24 09:00');
			expect(occurrence?.originalDate).toBe('2026-09-21');
		});

		it('shift judges the end date by the original date', () => {
			const s = schedule({ type: 'weekly', weekdaysMask: MON, holidayPolicy: 'shift', endDate: '2026-09-21' });
			expect(sequence(s, at('2026-09-18'), 3)).toEqual(['2026-09-24 09:00']);
		});
	});
});

describe('describeSchedule', () => {
	it('summarizes schedules in Japanese', () => {
		expect(describeSchedule(schedule({ type: 'weekly', weekdaysMask: MON | WED | FRI }))).toBe('毎週 月水金 09:00');
		expect(
			describeSchedule(
				schedule({
					type: 'monthly_nth_weekday',
					weekdaysMask: TUE,
					nthWeek: 2,
					holidayPolicy: 'shift',
					endDate: '2026-12-31',
					remainingCount: 3,
				}),
			),
		).toBe('毎月 第2火曜 09:00（祝日は次の平日・〜2026-12-31・残り3回）');
		expect(describeSchedule(schedule({ type: 'monthly_nth_weekday', weekdaysMask: FRI, nthWeek: 5 }))).toBe(
			'毎月 最終金曜 09:00',
		);
		expect(describeSchedule(schedule({ type: 'once', onceAt: at('2026-12-01', '10:30') }))).toBe(
			'1回のみ 2026-12-01 10:30',
		);
	});
});
