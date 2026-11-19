import {
	$channels$_$messages,
	buttonStyle,
	makeActionRow,
	makeButton,
	makeModal,
	makeSlashCommand,
	makeTextInput,
	textInputStyle,
} from 'discord-hono';
import { factory } from '../factory.ts';

const BUTTON_ID = 'open_anonymous_modal';
const MODAL_ID = 'anonymous_modal';
const INPUT_ID = 'message_content';

const openModalButton = makeButton(BUTTON_ID, '匿名メッセージを送る', buttonStyle.Primary);

const anonymousModal = makeModal(MODAL_ID, '匿名メッセージ送信', [
	makeActionRow([
		makeTextInput(INPUT_ID, '送信内容', textInputStyle.Paragraph)
			.placeholder('転送先チャンネルに送信するメッセージを入力してください')
			.required(true)
			.min_length(1)
			.max_length(2000),
	]),
]);

export const panelCommand = factory.command(makeSlashCommand('panel', '匿名メッセージ送信ボタンを表示します'), (c) => {
	return c.res({
		content: '下のボタンから匿名メッセージを送信できます。',
		components: [makeActionRow([openModalButton])],
	});
});

export const openModalComponent = factory.component(openModalButton, (c) => {
	return c.resModal(anonymousModal);
});

export const submitAnonymousModal = factory.modal(anonymousModal, (c) => {
	const content = c.var[INPUT_ID]?.trim();
	const targetChannelId = c.env.TARGET_CHANNEL_ID?.trim();

	return c.flags('EPHEMERAL').resDefer(async (deferred) => {
		if (!targetChannelId) {
			console.error('TARGET_CHANNEL_ID is not configured.');
			await deferred.followup('送信先チャンネルが設定されていません。管理者に連絡してください。');
			return;
		}

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

			await deferred.followup('メッセージを送信しました。');
		} catch (error) {
			console.error('Unexpected error while forwarding message:', error);
			await deferred.followup('メッセージの送信中にエラーが発生しました。');
		}
	});
});

export const transporterHandlers = [panelCommand, openModalComponent, submitAnonymousModal];
