import { type APIInteractionDataResolvedChannel, ChannelType, PermissionFlagsBits } from 'discord-api-types/v10';
import type { ReminderDb } from '../types.ts';
import { countLiveReminders, type MentionType, type ReminderRow } from './repository.ts';

/** 1 ユーザーあたりの有効なリマインダの上限 */
export const MAX_REMINDERS_PER_USER = 25;
/** 1 ギルドあたりの有効なリマインダの上限 */
export const MAX_REMINDERS_PER_GUILD = 500;
/** 本文の最大文字数 */
export const MAX_CONTENT_LENGTH = 1500;

export type CheckResult = { ok: true } | { ok: false; message: string };

const THREAD_TYPES = new Set<number>([
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
]);
/** リマインダの通知先にできるチャンネル種別 */
export const REMINDER_CHANNEL_TYPES = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
] as const;

export function hasPermission(permissions: string | undefined | null, flag: bigint): boolean {
	if (!permissions) {
		return false;
	}
	try {
		const bits = BigInt(permissions);
		return (bits & PermissionFlagsBits.Administrator) !== 0n || (bits & flag) === flag;
	} catch {
		return false;
	}
}

function canPostIn(permissions: string | undefined | null, channelType: number | undefined): boolean {
	const send =
		channelType !== undefined && THREAD_TYPES.has(channelType)
			? PermissionFlagsBits.SendMessagesInThreads
			: PermissionFlagsBits.SendMessages;
	return hasPermission(permissions, PermissionFlagsBits.ViewChannel) && hasPermission(permissions, send);
}

export interface ChannelTarget {
	channelId: string;
	channelType: number | undefined;
	/** 実行者のそのチャンネルでの権限 */
	memberPermissions: string | undefined;
	/** Bot のそのチャンネルでの権限 (実行したチャンネル以外では不明のため undefined) */
	appPermissions: string | undefined;
}

/**
 * 通知先チャンネルを決める。
 * - チャンネル指定あり: `resolved.channels[id].permissions` (実行者の権限) を使う
 * - 省略時: 実行したチャンネル。`member.permissions` / `app_permissions` はそのチャンネルでの権限
 */
export function resolveChannelTarget(params: {
	optionChannelId: string | undefined;
	resolvedChannels: Record<string, APIInteractionDataResolvedChannel> | undefined;
	interactionChannelId: string | undefined;
	interactionChannelType: number | undefined;
	memberPermissions: string | undefined;
	appPermissions: string | undefined;
}): ChannelTarget | null {
	const channelId = params.optionChannelId ?? params.interactionChannelId;
	if (!channelId) {
		return null;
	}
	if (params.optionChannelId && params.optionChannelId !== params.interactionChannelId) {
		const resolved = params.resolvedChannels?.[params.optionChannelId];
		return {
			channelId,
			channelType: resolved?.type,
			memberPermissions: resolved?.permissions,
			appPermissions: undefined,
		};
	}
	return {
		channelId,
		channelType: params.interactionChannelType,
		memberPermissions: params.memberPermissions,
		appPermissions: params.appPermissions,
	};
}

/** 通知先チャンネルに実行者 (と分かる範囲で Bot) が投稿できるか */
export function checkChannelTarget(target: ChannelTarget): CheckResult {
	if (
		target.channelType !== undefined &&
		!(REMINDER_CHANNEL_TYPES as readonly number[]).includes(target.channelType)
	) {
		return {
			ok: false,
			message: 'このチャンネルにはリマインダを設定できません。テキストチャンネルかスレッドを指定してください。',
		};
	}
	if (!canPostIn(target.memberPermissions, target.channelType)) {
		return { ok: false, message: `<#${target.channelId}> に投稿する権限がないため、リマインダを設定できません。` };
	}
	if (target.appPermissions !== undefined && !canPostIn(target.appPermissions, target.channelType)) {
		return {
			ok: false,
			message: `Bot が <#${target.channelId}> に投稿する権限を持っていません。管理者に連絡してください。`,
		};
	}
	return { ok: true };
}

export interface MentionSpec {
	type: MentionType;
	targetId: string | null;
}

/**
 * メンション先を検証する。
 * - `@everyone` (ギルド ID と同じロール) は禁止
 * - ロールは mentionable であるか、実行者が通知先で MENTION_EVERYONE を持つ場合のみ
 */
export function checkMention(params: {
	mention: MentionSpec;
	guildId: string;
	roleMentionable: boolean | undefined;
	targetPermissions: string | undefined;
}): CheckResult {
	const { mention } = params;
	if (mention.type !== 'role') {
		return { ok: true };
	}
	if (mention.targetId === params.guildId) {
		return { ok: false, message: '@everyone はメンション先に指定できません。' };
	}
	if (!params.roleMentionable && !hasPermission(params.targetPermissions, PermissionFlagsBits.MentionEveryone)) {
		return { ok: false, message: 'このロールをメンションする権限がありません。' };
	}
	return { ok: true };
}

export interface ActingMember {
	userId: string;
	roles: readonly string[];
	/** 操作したチャンネルでの権限 */
	permissions: string | undefined;
}

export function isModerator(member: ActingMember): boolean {
	return hasPermission(member.permissions, PermissionFlagsBits.ManageMessages);
}

/** 編集・削除・一時停止・再開できるか (登録者・MANAGE_MESSAGES 保持者) */
export function canManageReminder(reminder: Pick<ReminderRow, 'owner_id'>, member: ActingMember): boolean {
	return reminder.owner_id === member.userId || isModerator(member);
}

/** 完了・スヌーズできるか (登録者・メンション対象・対象ロールのメンバー・MANAGE_MESSAGES 保持者) */
export function canOperateOccurrence(
	reminder: Pick<ReminderRow, 'owner_id' | 'mention_type' | 'mention_target_id'>,
	member: ActingMember,
): boolean {
	if (canManageReminder(reminder, member)) {
		return true;
	}
	if (reminder.mention_type === 'user') {
		return reminder.mention_target_id === member.userId;
	}
	if (reminder.mention_type === 'role' && reminder.mention_target_id) {
		return member.roles.includes(reminder.mention_target_id);
	}
	return false;
}

/** 件数の上限を確認する */
export async function checkCreationLimits(db: ReminderDb, guildId: string, ownerId: string): Promise<CheckResult> {
	const [own, guild] = await Promise.all([
		countLiveReminders(db, { guildId, ownerId }),
		countLiveReminders(db, { guildId }),
	]);
	if (own >= MAX_REMINDERS_PER_USER) {
		return {
			ok: false,
			message: `登録できるリマインダは 1 人 ${MAX_REMINDERS_PER_USER} 件までです。不要なものを /remind delete で削除してください。`,
		};
	}
	if (guild >= MAX_REMINDERS_PER_GUILD) {
		return {
			ok: false,
			message: `このサーバーのリマインダが上限 (${MAX_REMINDERS_PER_GUILD} 件) に達しています。`,
		};
	}
	return { ok: true };
}
