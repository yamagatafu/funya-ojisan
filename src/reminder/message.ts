import {
	type APIActionRowComponent,
	type APIButtonComponentWithCustomId,
	ButtonStyle,
	ComponentType,
	type RESTPostAPIChannelMessageJSONBody,
} from 'discord-api-types/v10';
import { formatJstDateTime, formatJstTime, MINUTE_MS, utcMsToJst } from './date.ts';
import { describeSchedule, discordTimestamp, truncate } from './format.ts';
import type { ReminderRow } from './repository.ts';
import { reminderToSchedule } from './service.ts';

export const DONE_BUTTON_ID = 'remind_done';
export const SNOOZE_BUTTON_ID = 'remind_snooze';
export const SNOOZE_CUSTOM_BUTTON_ID = 'remind_snooze_custom';
export const SNOOZE_PRESET_MINUTES = [5, 15, 30] as const;

/** これ以上遅れて送る本通知には遅延の注記を付ける */
const LATE_NOTICE_THRESHOLD_MS = 5 * MINUTE_MS;

/** チャンネルに送信するメッセージ (Discord の送信ペイロードの一部) */
export type MessagePayload = Required<Pick<RESTPostAPIChannelMessageJSONBody, 'content' | 'allowed_mentions'>> &
	Pick<RESTPostAPIChannelMessageJSONBody, 'components'>;

export function mentionTargetOf(reminder: Pick<ReminderRow, 'mention_type' | 'mention_target_id' | 'owner_id'>): {
	text: string;
	allowedMentions: MessagePayload['allowed_mentions'];
} {
	switch (reminder.mention_type) {
		case 'self':
			return { text: `<@${reminder.owner_id}> `, allowedMentions: { parse: [], users: [reminder.owner_id] } };
		case 'user':
			return reminder.mention_target_id
				? {
						text: `<@${reminder.mention_target_id}> `,
						allowedMentions: { parse: [], users: [reminder.mention_target_id] },
					}
				: { text: '', allowedMentions: { parse: [] } };
		case 'role':
			return reminder.mention_target_id
				? {
						text: `<@&${reminder.mention_target_id}> `,
						allowedMentions: { parse: [], roles: [reminder.mention_target_id] },
					}
				: { text: '', allowedMentions: { parse: [] } };
		case 'none':
			return { text: '', allowedMentions: { parse: [] } };
	}
}

function footer(reminder: ReminderRow): string {
	return `-# #${reminder.id} · <@${reminder.owner_id}> · ${describeSchedule(reminderToSchedule(reminder))}`;
}

function body(reminder: ReminderRow): string[] {
	const lines = [reminder.content];
	if (reminder.source_message_url) {
		lines.push(`🔗 元メッセージ: ${reminder.source_message_url}`);
	}
	return lines;
}

export function buildActionButtons(occurrenceId: number): APIActionRowComponent<APIButtonComponentWithCustomId>[] {
	return [
		{
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.Button,
					style: ButtonStyle.Success,
					label: '完了',
					emoji: { name: '✅' },
					custom_id: `${DONE_BUTTON_ID};${occurrenceId}`,
				},
				...SNOOZE_PRESET_MINUTES.map(
					(minutes): APIButtonComponentWithCustomId => ({
						type: ComponentType.Button,
						style: ButtonStyle.Secondary,
						label: `${minutes}分`,
						emoji: { name: '⏰' },
						custom_id: `${SNOOZE_BUTTON_ID};${occurrenceId}:${minutes}`,
					}),
				),
				{
					type: ComponentType.Button,
					style: ButtonStyle.Secondary,
					label: '指定…',
					emoji: { name: '⏰' },
					custom_id: `${SNOOZE_CUSTOM_BUTTON_ID};${occurrenceId}`,
				},
			],
		},
	];
}

function lateNotice(scheduledAt: number, now: number): string {
	if (now - scheduledAt < LATE_NOTICE_THRESHOLD_MS) {
		return '';
	}
	const sameDay = utcMsToJst(scheduledAt).date === utcMsToJst(now).date;
	return `（予定 ${sameDay ? formatJstTime(scheduledAt) : formatJstDateTime(scheduledAt)} から遅延）`;
}

/** 本通知・再通知・スヌーズ通知 */
export function buildNotification(
	reminder: ReminderRow,
	params: {
		kind: 'main' | 'nag' | 'snooze';
		occurrenceId: number;
		scheduledAt: number;
		nagIndex?: number;
		now: number;
	},
): MessagePayload {
	const mention = mentionTargetOf(reminder);
	let header: string;
	switch (params.kind) {
		case 'main':
			header = `⏰ ${mention.text}リマインド${lateNotice(params.scheduledAt, params.now)}`;
			break;
		case 'nag':
			header = `🔁 ${mention.text}再通知 (${params.nagIndex ?? 1}/${reminder.nag_max_count ?? 1})`;
			break;
		case 'snooze':
			header = `⏰ ${mention.text}スヌーズしたリマインド`;
			break;
	}
	return {
		content: [header, ...body(reminder), footer(reminder)].join('\n'),
		components: buildActionButtons(params.occurrenceId),
		allowed_mentions: mention.allowedMentions,
	};
}

/** 事前通知 (ボタンなし) */
export function buildPreNotification(reminder: ReminderRow, runAt: number): MessagePayload {
	const mention = mentionTargetOf(reminder);
	const header = `⏳ ${mention.text}${reminder.pre_notify_minutes}分後（${formatJstTime(runAt)}）にリマインドがあります`;
	return {
		content: [header, ...body(reminder), footer(reminder)].join('\n'),
		allowed_mentions: mention.allowedMentions,
	};
}

/** 状態表示行 (完了・スヌーズ) の接頭辞。フッター (`-# #`) と区別できる形にする */
const STATUS_LINE_PATTERN = /^-# (✅|⏰|⏹️) .*$/;

/** 既存の状態表示行を取り除いてから、新しい状態表示行を末尾に付ける */
export function withStatusLine(content: string, statusLine: string | null): string {
	const lines = content.split('\n').filter((line) => !STATUS_LINE_PATTERN.test(line));
	if (statusLine) {
		lines.push(`-# ${statusLine}`);
	}
	return lines.join('\n');
}

const STATUS_LABELS: Record<ReminderRow['status'], string> = {
	active: '🟢 有効',
	paused: '⏸️ 一時停止中',
	ended: '⏹️ 終了',
	error: '⚠️ エラー',
};

export function statusLabel(reminder: Pick<ReminderRow, 'status'>): string {
	return STATUS_LABELS[reminder.status];
}

/** 登録・編集後に実行者へ返す要約 (Ephemeral 用) */
export function buildReminderSummary(reminder: ReminderRow, heading: string): string {
	const mention = mentionTargetOf(reminder).text.trim();
	const lines = [
		heading,
		`> ${truncate(reminder.content, 200).replaceAll('\n', '\n> ')}`,
		`- ID: #${reminder.id}（${statusLabel(reminder)}）`,
		`- 通知先: <#${reminder.channel_id}>${mention ? `（${mention}）` : ''}`,
		`- 予定: ${describeSchedule(reminderToSchedule(reminder))}`,
	];
	if (reminder.pre_notify_minutes) {
		lines.push(`- 事前通知: ${reminder.pre_notify_minutes}分前`);
	}
	if (reminder.nag_interval_minutes) {
		lines.push(`- 完了まで再通知: ${reminder.nag_interval_minutes}分おき・最大${reminder.nag_max_count ?? 1}回`);
	}
	if (reminder.next_run_at !== null && reminder.status === 'active') {
		lines.push(
			`- 次回: ${discordTimestamp(reminder.next_run_at, 'F')}（${discordTimestamp(reminder.next_run_at, 'R')}）`,
		);
	}
	if (reminder.status === 'error' && reminder.last_error) {
		lines.push(`- エラー: ${truncate(reminder.last_error, 200)}`);
	}
	return lines.join('\n');
}
