import { type APIInteraction, type APIInteractionGuildMember, GuildMemberFlags, Locale } from 'discord-api-types/v10';
import { vi } from 'vitest';
import { factory } from '../../src/factory.ts';
import type { AppBindings, PanelKvStore, ReminderDb } from '../../src/types.ts';

export const APPLICATION_ID = '123456789012345678';
export const GUILD_ID = '100000000000000000';
export const CHANNEL_ID = '200000000000000000';
export const USER_ID = '300000000000000000';
/** VIEW_CHANNEL | SEND_MESSAGES | SEND_MESSAGES_IN_THREADS */
export const MEMBER_PERMISSIONS = String((1n << 10n) | (1n << 11n) | (1n << 38n));
/** MEMBER_PERMISSIONS | MANAGE_MESSAGES */
export const MODERATOR_PERMISSIONS = String(BigInt(MEMBER_PERMISSIONS) | (1n << 13n));

export function createEnv(db: ReminderDb): AppBindings {
	const kv: PanelKvStore = {
		get: vi.fn(async () => null),
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
	};
	return {
		DISCORD_APPLICATION_ID: APPLICATION_ID,
		DISCORD_PUBLIC_KEY: '0'.repeat(64),
		DISCORD_TOKEN: 'test-bot-token',
		TARGET_CHANNEL_ID: '999999999999999999',
		PANEL_KV: kv,
		REMINDER_DB: db,
	};
}

/** 署名検証を省略したテスト用アプリ */
export function createApp(handlers: Parameters<ReturnType<typeof factory.discord>['loader']>[0]) {
	return factory.discord({ verify: () => true }).loader(handlers);
}

export function createExecutionContext() {
	const tasks: Promise<unknown>[] = [];
	const unimplemented = (): never => {
		throw new Error('Not implemented in test mock');
	};
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			tasks.push(promise);
		},
		passThroughOnException() {},
		exports: {
			get default() {
				return unimplemented();
			},
		},
		props: {},
		mapVirtualHost: unimplemented,
		abort: unimplemented,
		tracing: {
			enterSpan: unimplemented,
			startActiveSpan: unimplemented,
			startSpan: unimplemented,
			getActiveSpan: () => undefined,
			withActiveSpan: unimplemented,
			get Span() {
				return unimplemented();
			},
		},
	} satisfies ExecutionContext;

	return {
		ctx,
		async flush() {
			while (tasks.length > 0) {
				await Promise.all(tasks.splice(0));
			}
		},
	};
}

export function createInteractionRequest(interaction: APIInteraction | Record<string, unknown>) {
	return new Request('https://example.com/', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-signature-ed25519': '0'.repeat(128),
			'x-signature-timestamp': '1700000000',
		},
		body: JSON.stringify(interaction),
	});
}

export function createMember(params: {
	userId?: string;
	permissions?: string;
	roles?: string[];
}): APIInteractionGuildMember {
	return {
		user: {
			id: params.userId ?? USER_ID,
			username: 'user',
			discriminator: '0000',
			avatar: null,
			global_name: null,
		},
		roles: params.roles ?? [],
		premium_since: null,
		pending: false,
		mute: false,
		deaf: false,
		joined_at: '2026-01-01T00:00:00.000Z',
		flags: GuildMemberFlags.DidRejoin,
		permissions: params.permissions ?? MEMBER_PERMISSIONS,
	};
}

/** ギルド内インタラクションの共通フィールド */
export function baseInteractionFields(params: {
	member?: APIInteractionGuildMember;
	channelId?: string;
	channelType?: number;
	appPermissions?: string;
}) {
	const channelId = params.channelId ?? CHANNEL_ID;
	return {
		id: '400000000000000000',
		application_id: APPLICATION_ID,
		token: 'interaction-token',
		version: 1,
		app_permissions: params.appPermissions ?? MEMBER_PERMISSIONS,
		authorizing_integration_owners: {},
		entitlements: [],
		attachment_size_limit: 26214400,
		locale: Locale.Japanese,
		guild_id: GUILD_ID,
		guild_locale: Locale.Japanese,
		channel: { id: channelId, type: params.channelType ?? 0 },
		channel_id: channelId,
		member: params.member ?? createMember({}),
	};
}
