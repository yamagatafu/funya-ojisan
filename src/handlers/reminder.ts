import { factory } from '../factory.ts';
import { dispatchDueJobs } from '../reminder/dispatcher.ts';

export const REMINDER_CRON = '* * * * *';

export const reminderCron = factory.cron(REMINDER_CRON, async (c) => {
	if (!c.env.REMINDER_DB) {
		console.error('REMINDER_DB binding is not configured.');
		return;
	}
	await dispatchDueJobs({ db: c.env.REMINDER_DB, rest: c.rest });
});

export const reminderHandlers = [reminderCron];
