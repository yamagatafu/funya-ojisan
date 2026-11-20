import { PermissionFlagsBits } from 'discord-api-types/v10';
import {
	$channels$_$messages,
	$channels$_$messages$_,
	buttonStyle,
	makeActionRow,
	makeButton,
	makeModal,
	makeSlashCommand,
	makeTextInput,
	permissionFlags,
	textInputStyle,
} from 'discord-hono';
import { factory } from '../factory.ts';
import type { AppBindings, PanelKvStore } from '../types.ts';

const BUTTON_ID = 'open_anonymous_modal';
const MODAL_ID = 'anonymous_modal';
const INPUT_ID = 'message_content';
const PANEL_KV_KEY_PREFIX = 'panel_message:';
const MAX_PENDING_DELETE_IDS = 10;
const KV_PUT_MAX_ATTEMPTS = 3;
const KV_PUT_BASE_DELAY_MS = 1000;

const openModalButton = makeButton(BUTTON_ID, '匿名メッセージを送る', buttonStyle.Primary);

const panelMessagePayload = {
	content: '下のボタンから匿名メッセージを送信できます。',
	components: [makeActionRow([openModalButton])],
};

const anonymousModal = makeModal(MODAL_ID, '匿名メッセージ送信', [
	makeActionRow([
		makeTextInput(INPUT_ID, '送信内容', textInputStyle.Paragraph)
			.placeholder('転送先チャンネルに送信するメッセージを入力してください')
			.required(true)
			.min_length(1)
			.max_length(2000),
	]),
]);

type RestClient = Parameters<Parameters<typeof factory.command>[1]>[0]['rest'];

interface PanelState {
	currentId: string | null;
	pendingDeleteIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function extractMessageId(payload: unknown): string | null {
	if (!isRecord(payload)) {
		return null;
	}
	return typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null;
}

function parsePanelState(raw: string | null): PanelState {
	if (!raw) {
		return { currentId: null, pendingDeleteIds: [] };
	}

	if (!raw.startsWith('{')) {
		return { currentId: raw, pendingDeleteIds: [] };
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) {
			return { currentId: null, pendingDeleteIds: [] };
		}

		const currentId = typeof parsed.currentId === 'string' && parsed.currentId.length > 0 ? parsed.currentId : null;
		const pendingDeleteIds = Array.isArray(parsed.pendingDeleteIds)
			? parsed.pendingDeleteIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
			: [];

		return { currentId, pendingDeleteIds };
	} catch {
		return { currentId: null, pendingDeleteIds: [] };
	}
}

function hasManageMessagesPermission(permissions: string | undefined): boolean {
	if (!permissions) {
		return false;
	}

	try {
		const bits = BigInt(permissions);
		const required = PermissionFlagsBits.ManageMessages | PermissionFlagsBits.Administrator;
		return (bits & required) !== 0n;
	} catch {
		return false;
	}
}

function validateChannelAndEnv(params: {
	env: AppBindings;
	channelId: string | undefined;
}): { ok: true; targetChannelId: string; kv: PanelKvStore } | { ok: false; message: string } {
	const targetChannelId = params.env.TARGET_CHANNEL_ID?.trim();
	if (!targetChannelId) {
		return { ok: false, message: '送信先チャンネルが設定されていません。管理者に連絡してください。' };
	}

	if (!params.env.PANEL_KV) {
		console.error('PANEL_KV binding is not configured.');
		return { ok: false, message: 'KV ストレージが設定されていません。管理者に連絡してください。' };
	}

	if (params.channelId !== targetChannelId) {
		return { ok: false, message: 'このチャンネルでは使用できません。' };
	}

	return { ok: true, targetChannelId, kv: params.env.PANEL_KV };
}

async function putWithBackoff(kv: PanelKvStore, key: string, value: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= KV_PUT_MAX_ATTEMPTS; attempt++) {
		try {
			await kv.put(key, value);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < KV_PUT_MAX_ATTEMPTS) {
				await new Promise((resolve) => setTimeout(resolve, KV_PUT_BASE_DELAY_MS * attempt));
			}
		}
	}
	throw lastError;
}

async function postAndReplacePanelMessage(params: {
	rest: RestClient;
	kv: PanelKvStore;
	channelId: string;
}): Promise<boolean> {
	const { rest, kv, channelId } = params;
	const kvKey = `${PANEL_KV_KEY_PREFIX}${channelId}`;
	const state = parsePanelState(await kv.get(kvKey));

	const postResponse = await rest('POST', $channels$_$messages, [channelId], panelMessagePayload);
	if (!postResponse.ok) {
		const errorText = await postResponse.text();
		console.error('Failed to post panel message:', postResponse.status, errorText);
		return false;
	}

	const postedPayload: unknown = await postResponse.json();
	const newMessageId = extractMessageId(postedPayload);
	if (!newMessageId) {
		console.error('Posted panel message response did not contain a valid id.');
		return false;
	}

	const deleteTargets = Array.from(
		new Set([...(state.currentId ? [state.currentId] : []), ...state.pendingDeleteIds]),
	).filter((id) => id !== newMessageId);

	const remainingPendingIds: string[] = [];
	for (const targetId of deleteTargets) {
		try {
			const deleteResponse = await rest('DELETE', $channels$_$messages$_, [channelId, targetId]);
			if (!deleteResponse.ok && deleteResponse.status !== 404) {
				const errorText = await deleteResponse.text();
				console.error('Failed to delete previous panel message:', targetId, deleteResponse.status, errorText);
				remainingPendingIds.push(targetId);
			}
		} catch (error) {
			console.error('Unexpected error while deleting previous panel message:', targetId, error);
			remainingPendingIds.push(targetId);
		}
	}

	const nextState = {
		currentId: newMessageId,
		pendingDeleteIds: remainingPendingIds.slice(-MAX_PENDING_DELETE_IDS),
	} satisfies PanelState;

	await putWithBackoff(kv, kvKey, JSON.stringify(nextState));
	return true;
}

export const panelCommand = factory.command(
	makeSlashCommand('panel', '匿名メッセージ送信ボタンを表示します').default_member_permissions(
		String(permissionFlags('MANAGE_MESSAGES')),
	),
	(c) => {
		const validation = validateChannelAndEnv({
			env: c.env,
			channelId: c.interaction.channel_id,
		});
		if (!validation.ok) {
			return c.flags('EPHEMERAL').res(validation.message);
		}

		if (!hasManageMessagesPermission(c.interaction.member?.permissions)) {
			return c.flags('EPHEMERAL').res('このコマンドを実行する権限がありません。');
		}

		return c.flags('EPHEMERAL').resDefer(async (deferred) => {
			try {
				const posted = await postAndReplacePanelMessage({
					rest: deferred.rest,
					kv: validation.kv,
					channelId: validation.targetChannelId,
				});

				if (!posted) {
					await deferred.followup('送信パネルの投稿に失敗しました。');
					return;
				}

				await deferred.followup('送信パネルを設置しました。');
			} catch (error) {
				console.error('Unexpected error while posting panel message:', error);
				await deferred.followup('送信パネルの設置中にエラーが発生しました。');
			}
		});
	},
);

export const openModalComponent = factory.component(openModalButton, (c) => {
	const validation = validateChannelAndEnv({
		env: c.env,
		channelId: c.interaction.channel_id,
	});
	if (!validation.ok) {
		return c.flags('EPHEMERAL').res(validation.message);
	}

	return c.resModal(anonymousModal);
});

export const submitAnonymousModal = factory.modal(anonymousModal, (c) => {
	const validation = validateChannelAndEnv({
		env: c.env,
		channelId: c.interaction.channel_id,
	});
	if (!validation.ok) {
		return c.flags('EPHEMERAL').res(validation.message);
	}

	const content = c.var[INPUT_ID]?.trim();
	if (!content) {
		return c.flags('EPHEMERAL').res('送信内容が空のため送信できませんでした。');
	}

	return c.flags('EPHEMERAL').resDefer(async (deferred) => {
		try {
			const response = await deferred.rest('POST', $channels$_$messages, [validation.targetChannelId], {
				content,
				allowed_mentions: { parse: [] },
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('Failed to forward message:', response.status, errorText);
				await deferred.followup('メッセージの転送に失敗しました。時間をおいて再度お試しください。');
				return;
			}
		} catch (error) {
			console.error('Unexpected error while forwarding message:', error);
			await deferred.followup('メッセージの送信中にエラーが発生しました。');
			return;
		}

		try {
			const replaced = await postAndReplacePanelMessage({
				rest: deferred.rest,
				kv: validation.kv,
				channelId: validation.targetChannelId,
			});

			if (!replaced) {
				await deferred.followup('メッセージは送信しましたが、送信パネルの更新に失敗しました。');
				return;
			}

			await deferred.followup('メッセージを送信しました。');
		} catch (error) {
			console.error('Unexpected error while replacing panel message:', error);
			await deferred.followup('メッセージは送信しましたが、送信パネルの更新に失敗しました。');
		}
	});
});

export const transporterHandlers = [panelCommand, openModalComponent, submitAnonymousModal];
