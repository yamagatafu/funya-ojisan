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
import type { AppBindings } from '../src/types.ts';

const testEnv = {
	DISCORD_APPLICATION_ID: '123456789012345678',
	DISCORD_PUBLIC_KEY: '0'.repeat(64),
	DISCORD_TOKEN: 'test-bot-token',
	TARGET_CHANNEL_ID: '987654321098765432',
} satisfies AppBindings;

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
		exports: {},
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

	it('returns a message with an open-modal button on /panel command', async () => {
		const app = createTestApp();
		const { ctx } = createExecutionContext();

		const interaction = {
			id: '100',
			application_id: testEnv.DISCORD_APPLICATION_ID,
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

		const res = await app.fetch(createInteractionRequest(interaction), testEnv, ctx);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
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
			},
		});
	});

	it('opens the modal when the button is clicked', async () => {
		const app = createTestApp();
		const { ctx } = createExecutionContext();

		const interaction = {
			id: '101',
			application_id: testEnv.DISCORD_APPLICATION_ID,
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
					id: testEnv.DISCORD_APPLICATION_ID,
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

		const res = await app.fetch(createInteractionRequest(interaction), testEnv, ctx);
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

	it('forwards modal content to target channel via Discord REST API (not webhook)', async () => {
		const app = createTestApp();
		const { ctx, flush } = createExecutionContext();

		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ id: '999' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);

		const interaction = {
			id: '102',
			application_id: testEnv.DISCORD_APPLICATION_ID,
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
								value: 'テスト投稿です',
							},
						],
					},
				],
			},
		} satisfies APIModalSubmitInteraction;

		const res = await app.fetch(createInteractionRequest(interaction), testEnv, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
			},
		});

		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(2);

		const [postUrl, postInit] = fetchMock.mock.calls[0]!;
		expect(postUrl).toBe(`https://discord.com/api/v10/channels/${testEnv.TARGET_CHANNEL_ID}/messages`);
		expect(postInit?.method).toBe('POST');
		expect(postInit?.headers).toMatchObject({
			Authorization: `Bot ${testEnv.DISCORD_TOKEN}`,
			'content-type': 'application/json',
		});
		expect(JSON.parse(String(postInit?.body))).toEqual({
			content: 'テスト投稿です',
			allowed_mentions: { parse: [] },
		});

		const [followupUrl, followupInit] = fetchMock.mock.calls[1]!;
		expect(followupUrl).toBe(
			`https://discord.com/api/v10/webhooks/${testEnv.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`,
		);
		expect(followupInit?.method).toBe('PATCH');
		expect(JSON.parse(String(followupInit?.body))).toMatchObject({
			content: 'メッセージを送信しました。',
		});
	});

	it('notifies user when TARGET_CHANNEL_ID is missing', async () => {
		const app = createTestApp();
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
			application_id: testEnv.DISCORD_APPLICATION_ID,
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

		await app.fetch(createInteractionRequest(interaction), { ...testEnv, TARGET_CHANNEL_ID: '' }, ctx);
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
