import { makeActionRow, makeMessageCommand, makeModal, makeTextInput, textInputStyle } from 'discord-hono';
import { factory } from '../factory.ts';
import { DAY_MS, utcMsToJst } from '../reminder/date.ts';
import { truncate } from '../reminder/format.ts';
import { buildReminderSummary } from '../reminder/message.ts';
import { parseWhen } from '../reminder/parse.ts';
import {
	checkChannelTarget,
	checkCreationLimits,
	MAX_CONTENT_LENGTH,
	resolveChannelTarget,
} from '../reminder/permissions.ts';
import type { ReminderInput } from '../reminder/repository.ts';
import { createReminder } from '../reminder/service.ts';

export const REMIND_MESSAGE_COMMAND_NAME = 'このメッセージをリマインド';
export const REMIND_MESSAGE_MODAL_ID = 'remind_message_modal';
const WHEN_INPUT_ID = 'when';
const MEMO_INPUT_ID = 'memo';
/** メモに初期表示する元メッセージ本文の最大文字数 */
const MEMO_PREFILL_LENGTH = 200;
/** メモが空のときの本文 */
const DEFAULT_CONTENT = 'メッセージのリマインド';
/** 「いつ」に指定できる最も先の日時 (現在から) */
const MAX_AHEAD_MS = 365 * DAY_MS;

const WHEN_FORMAT_HELP = [
	'次のいずれかの形式で入力してください。',
	'- 相対指定: `30分` / `2時間` / `1h30m`',
	'- 時刻: `18:00`（過ぎていれば明日）',
	'- 日時: `2026-12-01 09:00` / `12/1 9:00`',
].join('\n');

/**
 * モーダルを組み立てる。builder は可変の proxy のため、呼び出しごとに新しく作る。
 * memo を渡すとメモ欄に初期値として表示する。
 */
function buildModal(memo?: string) {
	const memoInput = makeTextInput(MEMO_INPUT_ID, 'メモ', textInputStyle.Paragraph)
		.required(false)
		.max_length(MAX_CONTENT_LENGTH);
	return makeModal(REMIND_MESSAGE_MODAL_ID, REMIND_MESSAGE_COMMAND_NAME, [
		makeActionRow([
			makeTextInput(WHEN_INPUT_ID, 'いつ通知しますか', textInputStyle.Short)
				.placeholder('30分 / 2時間 / 18:00 / 12/1 9:00')
				.required(true),
		]),
		makeActionRow([memo ? memoInput.value(memo) : memoInput]),
	]);
}

export const remindMessageCommand = factory.command(
	makeMessageCommand(REMIND_MESSAGE_COMMAND_NAME).contexts([0]),
	(c) => {
		if (!c.interaction.guild_id) {
			return c.flags('EPHEMERAL').res('このコマンドはサーバー内でのみ使用できます。');
		}
		const messageId = c.interaction.data.target_id;
		const message = c.interaction.data.resolved.messages[messageId];
		const content = message?.content?.trim() ?? '';
		const modal = buildModal(content ? truncate(content, MEMO_PREFILL_LENGTH) : undefined).custom_value(messageId);
		return c.resModal(modal);
	},
);

export const remindMessageModal = factory.modal(buildModal(), async (c) => {
	const guildId = c.interaction.guild_id;
	const member = c.interaction.member;
	const channelId = c.interaction.channel?.id ?? c.interaction.channel_id;
	const messageId = c.ref.custom_value;
	if (!guildId || !member) {
		return c.flags('EPHEMERAL').res('このコマンドはサーバー内でのみ使用できます。');
	}
	if (!channelId || !messageId) {
		return c.flags('EPHEMERAL').res('元のメッセージを特定できませんでした。もう一度お試しください。');
	}

	const now = Date.now();
	const when = c.var[WHEN_INPUT_ID] ?? '';
	const runAt = parseWhen(when, now);
	if (runAt === null) {
		return c.flags('EPHEMERAL').res(`「いつ」を読み取れませんでした。\n${WHEN_FORMAT_HELP}`);
	}
	if (runAt <= now) {
		return c.flags('EPHEMERAL').res(`過去の日時は指定できません。\n${WHEN_FORMAT_HELP}`);
	}
	if (runAt - now > MAX_AHEAD_MS) {
		return c.flags('EPHEMERAL').res(`365 日より先の日時は指定できません。\n${WHEN_FORMAT_HELP}`);
	}

	const target = resolveChannelTarget({
		optionChannelId: undefined,
		resolvedChannels: undefined,
		interactionChannelId: channelId,
		interactionChannelType: c.interaction.channel?.type,
		memberPermissions: member.permissions,
		appPermissions: c.interaction.app_permissions,
	});
	if (!target) {
		return c.flags('EPHEMERAL').res('通知先のチャンネルを特定できませんでした。');
	}
	const channelCheck = checkChannelTarget(target);
	if (!channelCheck.ok) {
		return c.flags('EPHEMERAL').res(channelCheck.message);
	}

	const db = c.env.REMINDER_DB;
	if (!db) {
		console.error('REMINDER_DB binding is not configured.');
		return c.flags('EPHEMERAL').res('リマインダの保存先が設定されていません。管理者に連絡してください。');
	}
	const ownerId = member.user.id;
	const limitCheck = await checkCreationLimits(db, guildId, ownerId);
	if (!limitCheck.ok) {
		return c.flags('EPHEMERAL').res(limitCheck.message);
	}

	const memo = (c.var[MEMO_INPUT_ID] ?? '').trim();
	const input: ReminderInput = {
		guild_id: guildId,
		channel_id: target.channelId,
		owner_id: ownerId,
		content: memo ? truncate(memo, MAX_CONTENT_LENGTH) : DEFAULT_CONTENT,
		source_message_url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
		mention_type: 'self',
		mention_target_id: null,
		schedule_type: 'once',
		time_of_day: utcMsToJst(runAt).minutesOfDay,
		once_at: runAt,
		weekdays_mask: null,
		day_of_month: null,
		nth_week: null,
		start_date: null,
		holiday_policy: 'notify',
		pre_notify_minutes: null,
		nag_interval_minutes: null,
		nag_max_count: null,
		end_date: null,
		remaining_count: null,
	};
	const result = await createReminder(db, input, now);
	if (!result.ok) {
		return c.flags('EPHEMERAL').res(result.message);
	}
	return c
		.flags('EPHEMERAL')
		.res(buildReminderSummary(result.reminder, `✅ リマインダ #${result.reminder.id} を登録しました`));
});

export const reminderContextMenuHandlers = [remindMessageCommand, remindMessageModal];
