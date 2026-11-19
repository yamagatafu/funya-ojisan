import { createFactory } from 'discord-hono';
import type { AppEnv } from './types.ts';

export const factory = createFactory<AppEnv>();
