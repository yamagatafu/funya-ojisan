import {
	type APIChatInputApplicationCommandInteraction,
	type APIInteraction,
	type APIMessageComponentInteraction,
	type APIModalSubmitInteraction,
	ApplicationCommandType,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	Locale,
	MessageFlags,
} from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { factory } from '../src/factory.ts';
import { transporterHandlers } from '../src/handlers/transporter.ts';
import type { AppBindings, PanelKvStore } from '../src/types.ts';

function createMockKV(initialEntries: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initialEntries));

	const kv = {
		get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
	} satisfies PanelKvStore;

	return { kv, store };
}

function createTestEnv(initialKv: Record<string, string> = {}) {
	const { kv, store } = createMockKV(initialKv);
	const env = {
		DISCORD_APPLICATION_ID: '123456789012345678',
		DISCORD_PUBLIC_KEY: '0'.repeat(64),
		DISCORD_TOKEN: 'test-bot-token',
		TARGET_CHANNEL_ID: '987654321098765432',
		PANEL_KV: kv,
	} satisfies AppBindings;

	return { env, store };
}

function createTestApp() {
	return factory.discord({ verify: () => true }).loader(transporterHandlers);
}

function createExecutionContext() {
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
			await Promise.all(tasks);
		},
	};
}

function createInteractionRequest(interaction: APIInteraction) {
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

describe('anonymous transporter bot', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts a panel button message, deletes previous one via KV, and saves new message id on /panel', async () => {
		const app = createTestApp();
		const { env, store } = createTestEnv({
			'panel_message:111': 'old-panel-msg-1',
		});
		const { ctx, flush } = createExecutionContext();

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'new-panel-msg-2' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 204 }));

		const interaction = {
			id: '100',
			application_id: env.DISCORD_APPLICATION_ID,
			type: InteractionType.ApplicationCommand,
			token: 'interaction-token',
			version: 1,
			app_permissions: '0',
			authorizing_integration_owners: {},
			entitlements: [],
			attachment_size_limit: 26214400,
			locale: Locale.Japanese,
			channel: { id: '111', type: 0 },
			channel_id: '111',
			data: {
				id: '200',
				name: 'panel',
				type: ApplicationCommandType.ChatInput,
			},
		} satisfies APIChatInputApplicationCommandInteraction;

		const res = await app.fetch(createInteractionRequest(interaction), env, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
			},
		});

		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(3);

		const [postUrl, postInit] = fetchMock.mock.calls[0]!;
		expect(postUrl).toBe('https://discord.com/api/v10/channels/111/messages');
		expect(postInit?.method).toBe('POST');
		expect(JSON.parse(String(postInit?.body))).toMatchObject({
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.Button,
							custom_id: 'open_anonymous_modal',
						},
					],
				},
			],
		});

		const [deleteUrl, deleteInit] = fetchMock.mock.calls[1]!;
		expect(deleteUrl).toBe('https://discord.com/api/v10/channels/111/messages/old-panel-msg-1');
		expect(deleteInit?.method).toBe('DELETE');

		const [followupUrl, followupInit] = fetchMock.mock.calls[2]!;
		expect(followupUrl).toContain('/messages/@original');
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: '送信パネルを設置しました。',
		});

		expect(store.get('panel_message:111')).toBe('new-panel-msg-2');
	});

	it('opens the modal when the button is clicked', async () => {
		const app = createTestApp();
		const { env } = createTestEnv();
		const { ctx } = createExecutionContext();

		const interaction = {
			id: '101',
			application_id: env.DISCORD_APPLICATION_ID,
			type: InteractionType.MessageComponent,
			token: 'interaction-token',
			version: 1,
			app_permissions: '0',
			authorizing_integration_owners: {},
			entitlements: [],
			attachment_size_limit: 26214400,
			locale: Locale.Japanese,
			channel: { id: '111', type: 0 },
			channel_id: '111',
			message: {
				id: '300',
				channel_id: '111',
				author: {
					id: env.DISCORD_APPLICATION_ID,
					username: 'bot',
					discriminator: '0000',
					avatar: null,
					global_name: null,
				},
				content: '',
				timestamp: '2026-01-01T00:00:00.000Z',
				edited_timestamp: null,
				tts: false,
				mention_everyone: false,
				mentions: [],
				mention_roles: [],
				attachments: [],
				embeds: [],
				pinned: false,
				type: 0,
			},
			data: {
				component_type: ComponentType.Button,
				custom_id: 'open_anonymous_modal',
			},
		} satisfies APIMessageComponentInteraction;

		const res = await app.fetch(createInteractionRequest(interaction), env, ctx);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body).toMatchObject({
			type: InteractionResponseType.Modal,
			data: {
				custom_id: 'anonymous_modal',
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.TextInput,
								custom_id: 'message_content',
							},
						],
					},
				],
			},
		});
	});

	it('forwards modal content via REST API, posts a new panel button, deletes the old one, and updates KV', async () => {
		const app = createTestApp();
		const { env, store } = createTestEnv({
			[`panel_message:${'987654321098765432'}`]: 'old-panel-msg-10',
		});
		const { ctx, flush } = createExecutionContext();

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'forwarded-msg-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'new-panel-msg-20' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 204 }));

		const interaction = {
			id: '102',
			application_id: env.DISCORD_APPLICATION_ID,
			type: InteractionType.ModalSubmit,
			token: 'interaction-token',
			version: 1,
			app_permissions: '0',
			authorizing_integration_owners: {},
			entitlements: [],
			attachment_size_limit: 26214400,
			locale: Locale.Japanese,
			channel: { id: env.TARGET_CHANNEL_ID, type: 0 },
			channel_id: env.TARGET_CHANNEL_ID,
			data: {
				custom_id: 'anonymous_modal',
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.TextInput,
								custom_id: 'message_content',
								value: 'テスト投稿です',
							},
						],
					},
				],
			},
		} satisfies APIModalSubmitInteraction;

		const res = await app.fetch(createInteractionRequest(interaction), env, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
			},
		});

		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(4);

		const [forwardUrl, forwardInit] = fetchMock.mock.calls[0]!;
		expect(forwardUrl).toBe(`https://discord.com/api/v10/channels/${env.TARGET_CHANNEL_ID}/messages`);
		expect(forwardInit?.method).toBe('POST');
		expect(forwardInit?.headers).toMatchObject({
			Authorization: `Bot ${env.DISCORD_TOKEN}`,
			'content-type': 'application/json',
		});
		expect(JSON.parse(String(forwardInit?.body))).toEqual({
			content: 'テスト投稿です',
			allowed_mentions: { parse: [] },
		});

		const [panelPostUrl, panelPostInit] = fetchMock.mock.calls[1]!;
		expect(panelPostUrl).toBe(`https://discord.com/api/v10/channels/${env.TARGET_CHANNEL_ID}/messages`);
		expect(panelPostInit?.method).toBe('POST');
		expect(JSON.parse(String(panelPostInit?.body))).toMatchObject({
			components: [
				{
					type: ComponentType.ActionRow,
					components: [{ custom_id: 'open_anonymous_modal' }],
				},
			],
		});

		const [deleteUrl, deleteInit] = fetchMock.mock.calls[2]!;
		expect(deleteUrl).toBe(
			`https://discord.com/api/v10/channels/${env.TARGET_CHANNEL_ID}/messages/old-panel-msg-10`,
		);
		expect(deleteInit?.method).toBe('DELETE');

		const [followupUrl, followupInit] = fetchMock.mock.calls[3]!;
		expect(followupUrl).toBe(
			`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		);
		expect(followupInit?.method).toBe('PATCH');
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: 'メッセージを送信しました。',
		});

		expect(store.get(`panel_message:${env.TARGET_CHANNEL_ID}`)).toBe('new-panel-msg-20');
	});

	it('notifies user when TARGET_CHANNEL_ID is missing', async () => {
		const app = createTestApp();
		const { env } = createTestEnv();
		const { ctx, flush } = createExecutionContext();

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ id: '999' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const interaction = {
			id: '103',
			application_id: env.DISCORD_APPLICATION_ID,
			type: InteractionType.ModalSubmit,
			token: 'interaction-token',
			version: 1,
			app_permissions: '0',
			authorizing_integration_owners: {},
			entitlements: [],
			attachment_size_limit: 26214400,
			locale: Locale.Japanese,
			data: {
				custom_id: 'anonymous_modal',
				components: [
					{
						type: ComponentType.ActionRow,
						components: [
							{
								type: ComponentType.TextInput,
								custom_id: 'message_content',
								value: '送信テスト',
							},
						],
					},
				],
			},
		} satisfies APIModalSubmitInteraction;

		await app.fetch(createInteractionRequest(interaction), { ...env, TARGET_CHANNEL_ID: '' }, ctx);
		await flush();

		expect(consoleErrorSpy).toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [followupUrl, followupInit] = fetchMock.mock.calls[0]!;
		expect(followupUrl).toContain('/messages/@original');
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: '送信先チャンネルが設定されていません。管理者に連絡してください。',
		});
	});
});
