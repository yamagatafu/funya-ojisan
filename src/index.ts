import { factory } from './factory.ts';
import { reminderHandlers } from './handlers/reminder.ts';
import { transporterHandlers } from './handlers/transporter.ts';

export default factory.discord().loader([...transporterHandlers, ...reminderHandlers]);
