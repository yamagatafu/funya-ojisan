import {
	type APIChatInputApplicationCommandInteraction,
	type APIInteraction,
	type APIMessageComponentInteraction,
	type APIModalSubmitInteraction,
	ApplicationCommandType,
	ComponentType,
	GuildMemberFlags,
	InteractionResponseType,
	InteractionType,
	Locale,
	MessageFlags,
	PermissionFlagsBits,
} from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { factory } from '../src/factory.ts';
import { transporterHandlers } from '../src/handlers/transporter.ts';
import type { AppBindings, PanelKvStore } from '../src/types.ts';

const TARGET_CHANNEL_ID = '987654321098765432';

function createMockKV(initialEntries: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initialEntries));

	const kv = {
		get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
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
		TARGET_CHANNEL_ID,
		PANEL_KV: kv,
	} satisfies AppBindings;

	return { env, kv, store };
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

function createPanelCommandInteraction(params: {
	applicationId: string;
	channelId: string;
	permissions?: string;
}): APIChatInputApplicationCommandInteraction {
	return {
		id: '100',
		application_id: params.applicationId,
		type: InteractionType.ApplicationCommand,
		token: 'interaction-token',
		version: 1,
		app_permissions: '0',
		authorizing_integration_owners: {},
		entitlements: [],
		attachment_size_limit: 26214400,
		locale: Locale.Japanese,
		channel: { id: params.channelId, type: 0 },
		channel_id: params.channelId,
		member: {
			user: {
				id: '1',
				username: 'admin',
				discriminator: '0000',
				avatar: null,
				global_name: null,
			},
			roles: [],
			premium_since: null,
			pending: false,
			mute: false,
			deaf: false,
			joined_at: '2026-01-01T00:00:00.000Z',
			flags: GuildMemberFlags.DidRejoin,
			permissions: params.permissions ?? PermissionFlagsBits.ManageMessages.toString(),
		},
		data: {
			id: '200',
			name: 'panel',
			type: ApplicationCommandType.ChatInput,
		},
	};
}

function createButtonInteraction(params: { applicationId: string; channelId: string }): APIMessageComponentInteraction {
	return {
		id: '101',
		application_id: params.applicationId,
		type: InteractionType.MessageComponent,
		token: 'interaction-token',
		version: 1,
		app_permissions: '0',
		authorizing_integration_owners: {},
		entitlements: [],
		attachment_size_limit: 26214400,
		locale: Locale.Japanese,
		channel: { id: params.channelId, type: 0 },
		channel_id: params.channelId,
		message: {
			id: '300',
			channel_id: params.channelId,
			author: {
				id: params.applicationId,
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
	};
}

function createModalInteraction(params: {
	applicationId: string;
	channelId: string;
	value: string;
}): APIModalSubmitInteraction {
	return {
		id: '102',
		application_id: params.applicationId,
		type: InteractionType.ModalSubmit,
		token: 'interaction-token',
		version: 1,
		app_permissions: '0',
		authorizing_integration_owners: {},
		entitlements: [],
		attachment_size_limit: 26214400,
		locale: Locale.Japanese,
		channel: { id: params.channelId, type: 0 },
		channel_id: params.channelId,
		data: {
			custom_id: 'anonymous_modal',
			components: [
				{
					type: ComponentType.ActionRow,
					components: [
						{
							type: ComponentType.TextInput,
							custom_id: 'message_content',
							value: params.value,
						},
					],
				},
			],
		},
	};
}

describe('anonymous transporter bot', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('posts a panel button message, deletes previous one via KV, and saves new state on /panel', async () => {
		const app = createTestApp();
		const { env, store } = createTestEnv({
			[`panel_message:${TARGET_CHANNEL_ID}`]: 'old-panel-msg-1',
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

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

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
		expect(postUrl).toBe(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages`);
		expect(postInit?.method).toBe('POST');

		const [deleteUrl, deleteInit] = fetchMock.mock.calls[1]!;
		expect(deleteUrl).toBe(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/old-panel-msg-1`);
		expect(deleteInit?.method).toBe('DELETE');

		const [followupUrl, followupInit] = fetchMock.mock.calls[2]!;
		expect(followupUrl).toContain('/messages/@original');
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: '送信パネルを設置しました。',
		});

		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'new-panel-msg-2',
			pendingDeleteIds: [],
		});
	});

	it('posts initial panel without DELETE when KV is empty', async () => {
		const app = createTestApp();
		const { env, store } = createTestEnv();
		const { ctx, flush } = createExecutionContext();

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'first-panel-msg' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'first-panel-msg',
			pendingDeleteIds: [],
		});
	});

	it('retains failed delete id in pendingDeleteIds and retries on next replacement', async () => {
		const app = createTestApp();
		const { env, store } = createTestEnv({
			[`panel_message:${TARGET_CHANNEL_ID}`]: JSON.stringify({
				currentId: 'msg-1',
				pendingDeleteIds: [],
			}),
		});
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'msg-2' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction1 = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction1), env, ctx);
		await flush();

		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'msg-2',
			pendingDeleteIds: ['msg-1'],
		});

		fetchMock.mockClear();
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'msg-3' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		await app.fetch(createInteractionRequest(interaction1), env, ctx);
		await flush();

		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/msg-2`,
		);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/msg-1`,
		);
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'msg-3',
			pendingDeleteIds: [],
		});
	});

	it('retains all 11 failed deletion ids without slicing and cleans them all up on next replacement', async () => {
		const app = createTestApp();
		const pendingIds = Array.from({ length: 10 }, (_, i) => `old-pending-${i + 1}`);
		const { env, store } = createTestEnv({
			[`panel_message:${TARGET_CHANNEL_ID}`]: JSON.stringify({
				currentId: 'current-panel-0',
				pendingDeleteIds: pendingIds,
			}),
		});
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const url = String(input);
			if (init?.method === 'POST' && url.endsWith('/messages')) {
				return new Response(JSON.stringify({ id: 'new-panel-11' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (init?.method === 'DELETE') {
				return new Response('Server Error', { status: 500 });
			}
			return new Response(null, { status: 200 });
		});

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		await flush();

		const expectedPending = ['current-panel-0', ...pendingIds];
		expect(expectedPending).toHaveLength(11);
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'new-panel-11',
			pendingDeleteIds: expectedPending,
		});

		const deletedUrls: string[] = [];
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			if (init?.method === 'POST' && url.endsWith('/messages')) {
				return new Response(JSON.stringify({ id: 'final-panel-12' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (init?.method === 'DELETE') {
				deletedUrls.push(url);
				return new Response(null, { status: 204 });
			}
			return new Response(null, { status: 200 });
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		await flush();

		expect(deletedUrls).toHaveLength(12);
		for (const id of ['new-panel-11', ...expectedPending]) {
			expect(deletedUrls).toContain(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/${id}`);
		}
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'final-panel-12',
			pendingDeleteIds: [],
		});
	});

	it('rejects /panel when member lacks ManageMessages permission', async () => {
		const app = createTestApp();
		const { env } = createTestEnv();
		const { ctx } = createExecutionContext();
		const fetchMock = vi.spyOn(globalThis, 'fetch');

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			permissions: PermissionFlagsBits.SendMessages.toString(),
		});

		const res = await app.fetch(createInteractionRequest(interaction), env, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content: 'このコマンドを実行する権限がありません。',
				flags: MessageFlags.Ephemeral,
			},
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ignores /panel, button, and modal outside TARGET_CHANNEL_ID', async () => {
		const app = createTestApp();
		const { env } = createTestEnv();
		const { ctx } = createExecutionContext();
		const fetchMock = vi.spyOn(globalThis, 'fetch');

		const interactions = [
			createPanelCommandInteraction({ applicationId: env.DISCORD_APPLICATION_ID, channelId: '111' }),
			createButtonInteraction({ applicationId: env.DISCORD_APPLICATION_ID, channelId: '111' }),
			createModalInteraction({
				applicationId: env.DISCORD_APPLICATION_ID,
				channelId: '111',
				value: 'テスト',
			}),
		] satisfies APIInteraction[];

		for (const interaction of interactions) {
			const res = await app.fetch(createInteractionRequest(interaction), env, ctx);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				type: InteractionResponseType.ChannelMessageWithSource,
				data: {
					content: 'このチャンネルでは使用できません。',
					flags: MessageFlags.Ephemeral,
				},
			});
		}

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('opens the modal when the button is clicked in TARGET_CHANNEL_ID', async () => {
		const app = createTestApp();
		const { env } = createTestEnv();
		const { ctx } = createExecutionContext();

		const interaction = createButtonInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

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
			[`panel_message:${TARGET_CHANNEL_ID}`]: 'old-panel-msg-10',
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

		const interaction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: 'テスト投稿です',
		});

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
		expect(forwardUrl).toBe(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages`);
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
		expect(panelPostUrl).toBe(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages`);
		expect(panelPostInit?.method).toBe('POST');

		const [deleteUrl, deleteInit] = fetchMock.mock.calls[2]!;
		expect(deleteUrl).toBe(`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/old-panel-msg-10`);
		expect(deleteInit?.method).toBe('DELETE');

		const [followupUrl, followupInit] = fetchMock.mock.calls[3]!;
		expect(followupUrl).toBe(
			`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		);
		expect(followupInit?.method).toBe('PATCH');
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: 'メッセージを送信しました。',
		});

		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'new-panel-msg-20',
			pendingDeleteIds: [],
		});
	});

	it('retries kv.put with backoff without rerunning panel POST', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, kv, store } = createTestEnv();
		const { ctx, flush } = createExecutionContext();

		let putAttempts = 0;
		vi.spyOn(kv, 'put').mockImplementation(async (key, value) => {
			putAttempts += 1;
			if (putAttempts === 1) {
				throw new Error('429 Too Many Requests');
			}
			store.set(key, value);
		});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'forwarded-msg-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'new-panel-msg-2' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: 'リトライテスト',
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();
		await vi.runAllTimersAsync();
		await flushPromise;

		expect(putAttempts).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'new-panel-msg-2',
			pendingDeleteIds: [],
		});
		const [, followupInit] = fetchMock.mock.calls[2]!;
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: 'メッセージを送信しました。',
		});
	});

	it('falls back to backup KV key when primary kv.put fails 3 times, and cleans up on next invocation', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, kv, store } = createTestEnv();
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		let failPrimary = true;
		vi.spyOn(kv, 'put').mockImplementation(async (key, value) => {
			if (failPrimary && key === `panel_message:${TARGET_CHANNEL_ID}`) {
				throw new Error('429 Too Many Requests');
			}
			store.set(key, value);
		});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'forwarded-msg-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'backup-tracked-panel-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 200 }));

		const modalInteraction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: 'バックアップテスト',
		});

		await app.fetch(createInteractionRequest(modalInteraction), env, ctx);
		const flush1 = flush();
		await vi.runAllTimersAsync();
		await flush1;

		expect(JSON.parse(store.get(`panel_backup:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'backup-tracked-panel-1',
			pendingDeleteIds: [],
		});
		const [, followup1Init] = fetchMock.mock.calls[2]!;
		expect(JSON.parse(String(followup1Init?.body))).toMatchObject({
			content: 'メッセージを送信しました。',
		});

		failPrimary = false;
		fetchMock.mockClear();
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'next-panel-2' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const panelInteraction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(panelInteraction), env, ctx);
		const flush2 = flush();
		await vi.runAllTimersAsync();
		await flush2;

		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/backup-tracked-panel-1`,
		);
		expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
		expect(store.has(`panel_backup:${TARGET_CHANNEL_ID}`)).toBe(false);
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'next-panel-2',
			pendingDeleteIds: [],
		});
	});

	it('preserves existing panel and rolls back only new panel when both primary and backup KV puts fail', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, kv, store } = createTestEnv({
			[`panel_message:${TARGET_CHANNEL_ID}`]: 'existing-panel-1',
		});
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const putMock = vi.spyOn(kv, 'put').mockRejectedValue(new Error('429 Too Many Requests'));

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'forwarded-msg-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'new-panel-msg-2' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: 'テスト投稿です',
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();
		await vi.runAllTimersAsync();
		await flushPromise;

		expect(putMock).toHaveBeenCalledTimes(4);
		const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deleteCalls).toHaveLength(1);
		expect(deleteCalls[0]?.[0]).toBe(
			`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/new-panel-msg-2`,
		);
		expect(store.get(`panel_message:${TARGET_CHANNEL_ID}`)).toBe('existing-panel-1');
		const [, followupInit] = fetchMock.mock.calls[3]!;
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: 'メッセージは送信しましたが、送信パネルの更新に失敗しました。',
		});
	});

	it('waits until Retry-After before retrying rollback DELETE on 429', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, kv } = createTestEnv();
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(kv, 'put').mockRejectedValue(new Error('429 Too Many Requests'));

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'forwarded-msg-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'rollback-target-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ retry_after: 5 }), {
					status: 429,
					headers: {
						'content-type': 'application/json',
						'Retry-After': '5',
					},
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: '429 ロールバックテスト',
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();

		// kv.put リトライ分 (1000ms + 2000ms) を進めて 1回目の DELETE (429 Retry-After: 5) に到達させる
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);

		// 5000ms 未満 (4999ms) ではまだ 2回目の DELETE は送られない
		await vi.advanceTimersByTimeAsync(4999);
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);

		// 残り 1ms を進めて合計 5000ms 到達で 2回目の DELETE が送られる
		await vi.advanceTimersByTimeAsync(1);
		await flushPromise;

		const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deleteCalls).toHaveLength(2);
		expect(deleteCalls[0]?.[0]).toBe(
			`https://discord.com/api/v10/channels/${TARGET_CHANNEL_ID}/messages/rollback-target-1`,
		);
		const [, followupInit] = fetchMock.mock.calls[4]!;
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: 'メッセージは送信しましたが、送信パネルの更新に失敗しました。',
		});
	});

	it('does not retry rollback DELETE and alerts immediately when retry_after exceeds worker budget', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, kv } = createTestEnv();
		const { ctx, flush } = createExecutionContext();
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(kv, 'put').mockRejectedValue(new Error('KV Down'));

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'untracked-panel-budget' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ retry_after: 25 }), {
					status: 429,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();

		// KV リトライ分の 3,000ms だけ進め、25秒待機せずに即座にアラートが出ることを検証
		await vi.advanceTimersByTimeAsync(3000);

		const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deleteCalls).toHaveLength(1);

		const alertCall = consoleErrorSpy.mock.calls.find(
			(args) =>
				typeof args[0] === 'string' &&
				args[0].includes('[ALERT]') &&
				args[0].includes('requires manual deletion') &&
				args[0].includes(TARGET_CHANNEL_ID) &&
				args[0].includes('untracked-panel-budget'),
		);
		expect(alertCall).toBeDefined();

		await flushPromise;
	});

	it('defers remaining old-panel deletions when DELETE returns 429', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, store } = createTestEnv({
			[`panel_message:${TARGET_CHANNEL_ID}`]: JSON.stringify({
				currentId: 'old-1',
				pendingDeleteIds: ['old-2', 'old-3'],
			}),
		});
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'new-panel-4' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response('Rate Limited', { status: 429 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();
		await vi.runAllTimersAsync();
		await flushPromise;

		const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deleteCalls).toHaveLength(2);
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'new-panel-4',
			pendingDeleteIds: ['old-2', 'old-3'],
		});
	});

	it('alerts and drops unrecoverable 4xx (non-404/429) ids from pendingDeleteIds', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, store } = createTestEnv({
			[`panel_message:${TARGET_CHANNEL_ID}`]: JSON.stringify({
				currentId: 'forbidden-old-1',
				pendingDeleteIds: ['server-err-2'],
			}),
		});
		const { ctx, flush } = createExecutionContext();
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'new-panel-3' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response('Missing Permissions', { status: 403 }))
			.mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();
		await vi.runAllTimersAsync();
		await flushPromise;

		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'new-panel-3',
			pendingDeleteIds: ['server-err-2'],
		});
		const alertCall = consoleErrorSpy.mock.calls.find(
			(args) =>
				typeof args[0] === 'string' &&
				args[0].includes('[ALERT]') &&
				args[0].includes('4xx') &&
				args[0].includes('forbidden-old-1'),
		);
		expect(alertCall).toBeDefined();
	});

	it('defers remaining deletions when worker deadline is reached during cleanup loop', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, store } = createTestEnv({
			[`panel_message:${TARGET_CHANNEL_ID}`]: JSON.stringify({
				currentId: 'old-1',
				pendingDeleteIds: ['old-2', 'old-3'],
			}),
		});
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'new-panel-4' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockImplementationOnce(async () => {
				vi.advanceTimersByTime(26_000);
				return new Response(null, { status: 204 });
			})
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();
		await vi.runAllTimersAsync();
		await flushPromise;

		const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deleteCalls).toHaveLength(1);
		expect(JSON.parse(store.get(`panel_message:${TARGET_CHANNEL_ID}`) ?? '')).toEqual({
			currentId: 'new-panel-4',
			pendingDeleteIds: ['old-1', 'old-2', 'old-3'],
		});
	});

	it('alerts with channelId and messageId when rollback DELETE fails 3 times with 500', async () => {
		vi.useFakeTimers();
		const app = createTestApp();
		const { env, kv } = createTestEnv();
		const { ctx, flush } = createExecutionContext();
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(kv, 'put').mockRejectedValue(new Error('KV Down'));

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'untracked-panel-99' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
			.mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
			.mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		const flushPromise = flush();
		await vi.runAllTimersAsync();
		await flushPromise;

		const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
		expect(deleteCalls).toHaveLength(3);

		const alertCall = consoleErrorSpy.mock.calls.find(
			(args) =>
				typeof args[0] === 'string' &&
				args[0].includes('[ALERT]') &&
				args[0].includes('requires manual deletion') &&
				args[0].includes(TARGET_CHANNEL_ID) &&
				args[0].includes('untracked-panel-99'),
		);
		expect(alertCall).toBeDefined();

		const [, followupInit] = fetchMock.mock.calls[4]!;
		const followupBody = JSON.parse(String(followupInit?.body));
		expect(followupBody.content).toContain(TARGET_CHANNEL_ID);
		expect(followupBody.content).toContain('untracked-panel-99');
	});

	it('does not update panel when message forwarding returns 500', async () => {
		const app = createTestApp();
		const { env, kv } = createTestEnv();
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('Discord Error', { status: 500 }))
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: 'テスト投稿です',
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(kv.put).not.toHaveBeenCalled();
		const [, followupInit] = fetchMock.mock.calls[1]!;
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: 'メッセージの転送に失敗しました。時間をおいて再度お試しください。',
		});
	});

	it('fails closed when posted panel response lacks a valid id', async () => {
		const app = createTestApp();
		const { env, kv } = createTestEnv();
		const { ctx, flush } = createExecutionContext();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({}), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 200 }));

		const interaction = createPanelCommandInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
		});

		await app.fetch(createInteractionRequest(interaction), env, ctx);
		await flush();

		expect(kv.put).not.toHaveBeenCalled();
		const [, followupInit] = fetchMock.mock.calls[1]!;
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: '送信パネルの投稿に失敗しました。',
		});
	});

	it('rejects whitespace-only modal content immediately without calling fetch', async () => {
		const app = createTestApp();
		const { env } = createTestEnv();
		const { ctx } = createExecutionContext();
		const fetchMock = vi.spyOn(globalThis, 'fetch');

		const interaction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: '   \n\t  ',
		});

		const res = await app.fetch(createInteractionRequest(interaction), env, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content: '送信内容が空のため送信できませんでした。',
				flags: MessageFlags.Ephemeral,
			},
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('notifies user immediately when TARGET_CHANNEL_ID or PANEL_KV is missing', async () => {
		const app = createTestApp();
		const { env } = createTestEnv();
		const { ctx } = createExecutionContext();
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const interaction = createModalInteraction({
			applicationId: env.DISCORD_APPLICATION_ID,
			channelId: TARGET_CHANNEL_ID,
			value: '送信テスト',
		});

		const resMissingChannel = await app.fetch(
			createInteractionRequest(interaction),
			{ ...env, TARGET_CHANNEL_ID: '' },
			ctx,
		);
		expect(await resMissingChannel.json()).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content: '送信先チャンネルが設定されていません。管理者に連絡してください。',
				flags: MessageFlags.Ephemeral,
			},
		});

		const envWithoutKv = { ...env };
		Reflect.deleteProperty(envWithoutKv, 'PANEL_KV');
		const resMissingKv = await app.fetch(createInteractionRequest(interaction), envWithoutKv, ctx);
		expect(await resMissingKv.json()).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				content: 'KV ストレージが設定されていません。管理者に連絡してください。',
				flags: MessageFlags.Ephemeral,
			},
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
