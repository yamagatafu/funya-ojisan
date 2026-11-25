import { formatJstDateTime, formatMinutesOfDay } from './date.ts';
import { LAST_WEEK, type Schedule } from './schedule.ts';

/** 表示順 (月曜始まり) の曜日 */
const WEEKDAY_ORDER: [index: number, label: string][] = [
	[1, '月'],
	[2, '火'],
	[3, '水'],
	[4, '木'],
	[5, '金'],
	[6, '土'],
	[0, '日'],
];

export function formatWeekdays(mask: number | null): string {
	if (mask === null) {
		return '';
	}
	return WEEKDAY_ORDER.filter(([index]) => (mask & (1 << index)) !== 0)
		.map(([, label]) => label)
		.join('');
}

function describePattern(schedule: Schedule): string {
	const time = formatMinutesOfDay(schedule.timeOfDay);
	switch (schedule.type) {
		case 'once':
			return schedule.onceAt !== null ? `1回のみ ${formatJstDateTime(schedule.onceAt)}` : '1回のみ';
		case 'daily':
			return `毎日 ${time}`;
		case 'weekdays':
			return `平日 ${time}`;
		case 'weekly':
			return `毎週 ${formatWeekdays(schedule.weekdaysMask)} ${time}`;
		case 'biweekly':
			return `隔週 ${formatWeekdays(schedule.weekdaysMask)} ${time}`;
		case 'monthly_day':
			return `毎月 ${schedule.dayOfMonth}日 ${time}`;
		case 'monthly_last':
			return `毎月 末日 ${time}`;
		case 'monthly_nth_weekday': {
			const week = schedule.nthWeek === LAST_WEEK ? '最終' : `第${schedule.nthWeek}`;
			return `毎月 ${week}${formatWeekdays(schedule.weekdaysMask)}曜 ${time}`;
		}
	}
}

/** 例: `毎週 月水金 09:00（祝日はスキップ・〜2026-12-31・残り3回）` */
export function describeSchedule(schedule: Schedule): string {
	const notes: string[] = [];
	if (schedule.holidayPolicy === 'skip') {
		notes.push('祝日はスキップ');
	} else if (schedule.holidayPolicy === 'shift') {
		notes.push('祝日は次の平日');
	}
	if (schedule.type !== 'once') {
		if (schedule.endDate) {
			notes.push(`〜${schedule.endDate}`);
		}
		if (schedule.remainingCount !== null) {
			notes.push(`残り${schedule.remainingCount}回`);
		}
	}
	const pattern = describePattern(schedule);
	return notes.length > 0 ? `${pattern}（${notes.join('・')}）` : pattern;
}

export function truncate(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** Discord のタイムスタンプ記法 */
export function discordTimestamp(ms: number, style: 'F' | 'f' | 'R' | 't' | 'd' = 'f'): string {
	return `<t:${Math.floor(ms / 1000)}:${style}>`;
}
