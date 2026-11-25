import { factory } from '../factory.ts';
import { dispatchDueJobs } from '../reminder/dispatcher.ts';
import { reminderActionHandlers } from './reminder-actions.ts';
import { reminderCommandHandlers } from './reminder-commands.ts';
import { reminderContextMenuHandlers } from './reminder-context-menu.ts';
import { reminderGuiBaseHandlers } from './reminder-gui-base.ts';

export const REMINDER_CRON = '* * * * *';

export const reminderCron = factory.cron(REMINDER_CRON, async (c) => {
	if (!c.env.REMINDER_DB) {
		console.error('REMINDER_DB binding is not configured.');
		return;
	}
	await dispatchDueJobs({ db: c.env.REMINDER_DB, rest: c.rest });
});

export const reminderHandlers = [
	reminderCron,
	...reminderCommandHandlers,
	...reminderActionHandlers,
	...reminderContextMenuHandlers,
	...reminderGuiBaseHandlers,
];
