import {
	$channels$_$messages,
	$channels$_$messages$_,
	buttonStyle,
	makeActionRow,
	makeButton,
	makeModal,
	makeSlashCommand,
	makeTextInput,
	textInputStyle,
} from 'discord-hono';
import { factory } from '../factory.ts';
import type { PanelKvStore } from '../types.ts';

const BUTTON_ID = 'open_anonymous_modal';
const MODAL_ID = 'anonymous_modal';
const INPUT_ID = 'message_content';
const PANEL_KV_KEY_PREFIX = 'panel_message:';

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

async function postAndReplacePanelMessage(params: {
	rest: RestClient;
	kv: PanelKvStore | undefined;
	channelId: string;
}): Promise<boolean> {
	const { rest, kv, channelId } = params;
	const kvKey = `${PANEL_KV_KEY_PREFIX}${channelId}`;
	const oldMessageId = kv ? await kv.get(kvKey) : null;

	const postResponse = await rest('POST', $channels$_$messages, [channelId], panelMessagePayload);
	if (!postResponse.ok) {
		const errorText = await postResponse.text();
		console.error('Failed to post panel message:', postResponse.status, errorText);
		return false;
	}

	const postedMessage = await postResponse.json();

	if (oldMessageId && oldMessageId !== postedMessage.id) {
		const deleteResponse = await rest('DELETE', $channels$_$messages$_, [channelId, oldMessageId]);
		if (!deleteResponse.ok && deleteResponse.status !== 404) {
			const errorText = await deleteResponse.text();
			console.error('Failed to delete previous panel message:', deleteResponse.status, errorText);
		}
	}

	if (kv) {
		await kv.put(kvKey, postedMessage.id);
	}

	return true;
}

export const panelCommand = factory.command(makeSlashCommand('panel', '匿名メッセージ送信ボタンを表示します'), (c) => {
	const targetChannelId = c.env.TARGET_CHANNEL_ID?.trim();
	if (!targetChannelId) {
		return c.flags('EPHEMERAL').res('送信先チャンネルが設定されていません。管理者に連絡してください。');
	}

	if (c.interaction.channel_id !== targetChannelId) {
		return c.flags('EPHEMERAL').res('このチャンネルでは使用できません。');
	}

	return c.flags('EPHEMERAL').resDefer(async (deferred) => {
		try {
			const posted = await postAndReplacePanelMessage({
				rest: deferred.rest,
				kv: deferred.env.PANEL_KV,
				channelId: targetChannelId,
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
});

export const openModalComponent = factory.component(openModalButton, (c) => {
	const targetChannelId = c.env.TARGET_CHANNEL_ID?.trim();
	if (!targetChannelId) {
		return c.flags('EPHEMERAL').res('送信先チャンネルが設定されていません。管理者に連絡してください。');
	}

	if (c.interaction.channel_id !== targetChannelId) {
		return c.flags('EPHEMERAL').res('このチャンネルでは使用できません。');
	}

	return c.resModal(anonymousModal);
});

export const submitAnonymousModal = factory.modal(anonymousModal, (c) => {
	const targetChannelId = c.env.TARGET_CHANNEL_ID?.trim();
	if (!targetChannelId) {
		return c.flags('EPHEMERAL').res('送信先チャンネルが設定されていません。管理者に連絡してください。');
	}

	if (c.interaction.channel_id !== targetChannelId) {
		return c.flags('EPHEMERAL').res('このチャンネルでは使用できません。');
	}

	const content = c.var[INPUT_ID]?.trim();

	return c.flags('EPHEMERAL').resDefer(async (deferred) => {
		if (!content) {
			await deferred.followup('送信内容が空のため送信できませんでした。');
			return;
		}

		try {
			const response = await deferred.rest('POST', $channels$_$messages, [targetChannelId], {
				content,
				allowed_mentions: { parse: [] },
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('Failed to forward message:', response.status, errorText);
				await deferred.followup('メッセージの転送に失敗しました。時間をおいて再度お試しください。');
				return;
			}

			await postAndReplacePanelMessage({
				rest: deferred.rest,
				kv: deferred.env.PANEL_KV,
				channelId: targetChannelId,
			});

			await deferred.followup('メッセージを送信しました。');
		} catch (error) {
			console.error('Unexpected error while forwarding message:', error);
			await deferred.followup('メッセージの送信中にエラーが発生しました。');
		}
	});
});

export const transporterHandlers = [panelCommand, openModalComponent, submitAnonymousModal];
