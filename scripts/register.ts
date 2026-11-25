import { inspectResponse, register } from 'discord-hono';
import { factory } from '../src/factory.ts';
import { reminderHandlers } from '../src/handlers/reminder.ts';
import { transporterHandlers } from '../src/handlers/transporter.ts';

const applicationId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID || undefined;

if (!applicationId || !token) {
	console.error('DISCORD_APPLICATION_ID and DISCORD_TOKEN must be set.');
	process.exit(1);
}

const commands = factory.getCommands([...transporterHandlers, ...reminderHandlers]);
const response = await register(commands, applicationId, token, guildId);
const result = await inspectResponse(response);

if (!response.ok) {
	console.error('Failed to register commands:', result.message);
	process.exit(1);
}

console.log('Successfully registered commands:', guildId ? `guild=${guildId}` : 'global');
