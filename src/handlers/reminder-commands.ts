import {
	type APIAllowedMentions,
	type APIInteractionDataResolved,
	type APIInteractionGuildMember,
	PermissionFlagsBits,
} from 'discord-api-types/v10';
import {
	makeBooleanOption,
	makeChannelOption,
	makeIntegerOption,
	makeMentionableOption,
	makeSlashCommand,
	makeStringOption,
	makeSubCommand,
} from 'discord-hono';
import { factory } from '../factory.ts';
import type { Rest } from '../reminder/dispatcher.ts';
import { removeButtons } from '../reminder/dispatcher.ts';
import { describeSchedule, discordTimestamp, truncate } from '../reminder/format.ts';
import { buildReminderSummary, statusLabel } from '../reminder/message.ts';
import {
	buildScheduleForAdd,
	buildScheduleForEdit,
	buildScheduleForRelative,
	HOLIDAY_LABELS,
	hasAnyValue,
	MAX_RELATIVE_MINUTES,
	type OptionResult,
	REPEAT_LABELS,
	resolveMentionOption,
	type ScheduleFields,
	type ScheduleOptionValues,
} from '../reminder/options.ts';
import {
	type ActingMember,
	type CheckResult,
	canManageReminder,
	checkChannelTarget,
	checkCreationLimits,
	checkMention,
	hasPermission,
	isModerator,
	MAX_CONTENT_LENGTH,
	MAX_REMINDERS_PER_GUILD,
	MAX_REMINDERS_PER_USER,
	REMINDER_CHANNEL_TYPES,
	resolveChannelTarget,
} from '../reminder/permissions.ts';
import {
	countLiveReminders,
	deleteReminder,
	getReminder,
	listOpenOccurrences,
	listReminders,
	type ReminderInput,
	type ReminderRow,
	type ReminderUpdate,
	updateReminderStatement,
	withinLimitsCondition,
} from '../reminder/repository.ts';
import { computeNextOccurrence, HOLIDAY_POLICIES, SCHEDULE_TYPES } from '../reminder/schedule.ts';
import {
	cancelUpcomingStatement,
	createReminder,
	reminderToSchedule,
	updateReminderAndSchedule,
} from '../reminder/service.ts';
import type { DbStatement } from '../types.ts';

function compact(statements: (DbStatement | null)[]): DbStatement[] {
	return statements.filter((statement): statement is DbStatement => statement !== null);
}

import type { ReminderDb } from '../types.ts';

/** 一覧に表示する最大件数 */
const LIST_LIMIT = 25;
/** Discord のメッセージの最大文字数 */
const MESSAGE_MAX_LENGTH = 2000;
/** 一覧で表示する本文の最大文字数 */
const LIST_CONTENT_LENGTH = 40;
/** オートコンプリートの選択肢の最大件数・最大文字数 */
const AUTOCOMPLETE_LIMIT = 25;
const AUTOCOMPLETE_NAME_LENGTH = 100;
/** ギルドで実行したことを示すインタラクションのコンテキスト */
const GUILD_CONTEXT = 0;

// ---- コマンド定義 ----
// ビルダーは可変のプロキシのため、共有せず毎回作る

function contentOption(required: boolean) {
	const option = makeStringOption('content', 'リマインドする内容').max_length(MAX_CONTENT_LENGTH);
	return required ? option.required(true) : option;
}

function channelOption() {
	return makeChannelOption('channel', '通知先チャンネル（既定: このチャンネル）').channel_types([
		...REMINDER_CHANNEL_TYPES,
	]);
}

function mentionOption() {
	return makeMentionableOption('mention', 'メンション先（既定: 自分）');
}

function idOption() {
	return makeIntegerOption('id', 'リマインダの ID').required(true).min_value(1).autocomplete(true);
}

/** add と edit で共通のスケジュール関連オプション (edit では 0 / なし で解除できる) */
function scheduleOptions(mode: 'add' | 'edit') {
	const edit = mode === 'edit';
	return [
		makeStringOption('repeat', edit ? '繰り返し' : '繰り返し（既定: 1回のみ）').choices(
			SCHEDULE_TYPES.map((type) => ({ name: REPEAT_LABELS[type], value: type })),
		),
		channelOption(),
		makeStringOption('date', '1回のみ: 実行日 / 繰り返し: 開始日（YYYY-MM-DD または M/D）'),
		makeStringOption('weekdays', '曜日（例: 月水金）。毎週・隔週・毎月第n曜日で使用'),
		makeIntegerOption('day', '日付（1〜31）。毎月n日で使用').min_value(1).max_value(31),
		makeIntegerOption('nth', '第何週か（5 は最終週）。毎月第n曜日で使用').min_value(1).max_value(5),
		mentionOption(),
		makeIntegerOption('pre_notify', edit ? '事前通知（何分前か。0 で解除）' : '事前通知（何分前か）')
			.min_value(edit ? 0 : 1)
			.max_value(1440),
		makeIntegerOption(
			'nag_interval',
			edit ? '完了するまで再通知する間隔（分。0 で解除）' : '完了するまで再通知する間隔（分）',
		)
			.min_value(edit ? 0 : 5)
			.max_value(1440),
		makeIntegerOption('nag_max', '再通知の最大回数（既定: 3）').min_value(1).max_value(10),
		makeStringOption('holidays', '祝日の扱い（繰り返しのみ。既定: 通知する）').choices(
			HOLIDAY_POLICIES.map((policy) => ({ name: HOLIDAY_LABELS[policy], value: policy })),
		),
		makeStringOption(
			'until',
			edit ? '終了日（YYYY-MM-DD または M/D。なし で解除）' : '終了日（YYYY-MM-DD または M/D）',
		),
		makeIntegerOption('count', edit ? '残りの通知回数（0 で無制限）' : '通知する回数')
			.min_value(edit ? 0 : 1)
			.max_value(1000),
	];
}

export const remindCommandDefinition = makeSlashCommand('remind', 'リマインダを設定します')
	.contexts([GUILD_CONTEXT])
	.options([
		makeSubCommand('add', 'リマインダを登録します').options([
			contentOption(true),
			makeStringOption('time', '時刻（HH:MM）').required(true),
			...scheduleOptions('add'),
		]),
		makeSubCommand('in', '指定した時間が経ったら 1 回だけリマインドします').options([
			contentOption(true),
			makeIntegerOption('minutes', '何分後か').min_value(0).max_value(MAX_RELATIVE_MINUTES),
			makeIntegerOption('hours', '何時間後か')
				.min_value(0)
				.max_value(MAX_RELATIVE_MINUTES / 60),
			makeIntegerOption('days', '何日後か')
				.min_value(0)
				.max_value(MAX_RELATIVE_MINUTES / (24 * 60)),
			channelOption(),
			mentionOption(),
		]),
		makeSubCommand('edit', 'リマインダを編集します（指定した項目だけ変更）').options([
			idOption(),
			contentOption(false),
			makeStringOption('time', '時刻（HH:MM）'),
			...scheduleOptions('edit'),
		]),
		makeSubCommand('list', 'リマインダの一覧を表示します').options([
			makeBooleanOption('all', 'サーバー全体のリマインダを表示（メッセージの管理権限が必要）'),
		]),
		makeSubCommand('delete', 'リマインダを削除します').options([idOption()]),
		makeSubCommand('pause', 'リマインダを一時停止します').options([idOption()]),
		makeSubCommand('resume', '一時停止したリマインダを再開します').options([idOption()]),
	]);

// ---- 共通処理 ----

/** 全サブコマンドのオプション (Discord から受け取った値) */
interface RemindOptions extends ScheduleOptionValues {
	id?: number;
	content?: string;
	channel?: string;
	mention?: string;
	minutes?: number;
	hours?: number;
	days?: number;
	all?: boolean;
}

interface Invocation {
	db: ReminderDb;
	now: number;
	guildId: string;
	actor: ActingMember;
	channelId: string | undefined;
	channelType: number | undefined;
	appPermissions: string | undefined;
	resolved: APIInteractionDataResolved | undefined;
	opts: RemindOptions;
}

/** 即時に返す応答か、遅延応答 (REST を使う処理の後に返す) */
type Reply = string | { deferred: (rest: Rest) => Promise<string> };

function actorOf(member: APIInteractionGuildMember): ActingMember {
	return { userId: member.user.id, roles: member.roles, permissions: member.permissions };
}

function notFound(id: number | undefined): string {
	return `リマインダ #${id ?? '?'} が見つかりません。`;
}

/** 操作できるリマインダを取得する (他のギルドのもの・権限がないものは見つからない扱い) */
async function findManageableReminder(inv: Invocation): Promise<ReminderRow | null> {
	if (inv.opts.id === undefined) {
		return null;
	}
	const reminder = await getReminder(inv.db, inv.opts.id);
	if (!reminder || reminder.guild_id !== inv.guildId || !canManageReminder(reminder, inv.actor)) {
		return null;
	}
	return reminder;
}

function normalizeContent(content: string | undefined): OptionResult<string> {
	const trimmed = content?.trim() ?? '';
	if (trimmed.length === 0) {
		return { ok: false, message: 'content（内容）を入力してください。' };
	}
	if (trimmed.length > MAX_CONTENT_LENGTH) {
		return { ok: false, message: `content（内容）は ${MAX_CONTENT_LENGTH} 文字以内で入力してください。` };
	}
	return { ok: true, value: trimmed };
}

/** 通知先チャンネルとメンションを検証する (登録用) */
function resolveTargetAndMention(
	inv: Invocation,
	ownerId: string,
): OptionResult<Pick<ReminderInput, 'channel_id' | 'mention_type' | 'mention_target_id'>> {
	const target = resolveChannelTarget({
		optionChannelId: inv.opts.channel,
		resolvedChannels: inv.resolved?.channels,
		interactionChannelId: inv.channelId,
		interactionChannelType: inv.channelType,
		memberPermissions: inv.actor.permissions,
		appPermissions: inv.appPermissions,
	});
	if (!target) {
		return { ok: false, message: '通知先のチャンネルを特定できませんでした。channel を指定してください。' };
	}
	const channelCheck = checkChannelTarget(target);
	if (!channelCheck.ok) {
		return channelCheck;
	}
	const mention = resolveMentionOption(inv.opts.mention, ownerId, inv.resolved);
	if (!mention.ok) {
		return mention;
	}
	const mentionCheck = checkMention({
		mention: mention.value.mention,
		guildId: inv.guildId,
		roleMentionable: mention.value.roleMentionable,
		targetPermissions: target.memberPermissions,
	});
	if (!mentionCheck.ok) {
		return mentionCheck;
	}
	return {
		ok: true,
		value: {
			channel_id: target.channelId,
			mention_type: mention.value.mention.type,
			mention_target_id: mention.value.mention.targetId,
		},
	};
}

async function register(inv: Invocation, content: string | undefined, schedule: ScheduleFields): Promise<string> {
	const normalized = normalizeContent(content);
	if (!normalized.ok) {
		return normalized.message;
	}
	const target = resolveTargetAndMention(inv, inv.actor.userId);
	if (!target.ok) {
		return target.message;
	}
	const limits = await checkCreationLimits(inv.db, inv.guildId, inv.actor.userId);
	if (!limits.ok) {
		return limits.message;
	}
	const result = await createReminder(
		inv.db,
		{
			guild_id: inv.guildId,
			owner_id: inv.actor.userId,
			content: normalized.value,
			source_message_url: null,
			...target.value,
			...schedule,
		},
		inv.now,
	);
	if (!result.ok) {
		return result.message;
	}
	return buildReminderSummary(result.reminder, `✅ リマインダ #${result.reminder.id} を登録しました`);
}

// ---- サブコマンド ----

async function handleAdd(inv: Invocation): Promise<Reply> {
	const schedule = buildScheduleForAdd(inv.opts, inv.now);
	if (!schedule.ok) {
		return schedule.message;
	}
	return register(inv, inv.opts.content, schedule.value);
}

async function handleIn(inv: Invocation): Promise<Reply> {
	const schedule = buildScheduleForRelative(inv.opts, inv.now);
	if (!schedule.ok) {
		return schedule.message;
	}
	return register(inv, inv.opts.content, schedule.value);
}

/**
 * 実行者が今の通知先に投稿できるかを確認する (通知先を変えない編集・再開)。
 * 実行者の権限は実行したチャンネルの分しか分からないため、通知先以外で実行された場合は案内を返す
 */
function checkCurrentTarget(inv: Invocation, reminder: ReminderRow, action: 'edit' | 'resume'): CheckResult {
	if (reminder.channel_id !== inv.channelId) {
		return {
			ok: false,
			message:
				action === 'edit'
					? `通知先 <#${reminder.channel_id}> への投稿権限を確認するため、通知先のチャンネルで実行するか、channel オプションで通知先を指定してください。`
					: `通知先 <#${reminder.channel_id}> への投稿権限を確認するため、通知先のチャンネルで実行してください。`,
		};
	}
	const target = resolveChannelTarget({
		optionChannelId: undefined,
		resolvedChannels: undefined,
		interactionChannelId: inv.channelId,
		interactionChannelType: inv.channelType,
		memberPermissions: inv.actor.permissions,
		appPermissions: inv.appPermissions,
	});
	return target ? checkChannelTarget(target) : { ok: false, message: '通知先のチャンネルを特定できませんでした。' };
}

function conflictMessage(id: number): string {
	return `リマインダ #${id} は他の操作 (通知・編集など) と同時に更新されたため、変更を保存できませんでした。もう一度実行してください。`;
}

async function handleEdit(inv: Invocation): Promise<Reply> {
	const reminder = await findManageableReminder(inv);
	if (!reminder) {
		return notFound(inv.opts.id);
	}
	const { id: _id, ...changes } = inv.opts;
	if (!hasAnyValue(changes)) {
		return '変更する項目を 1 つ以上指定してください。';
	}

	const schedule = buildScheduleForEdit(reminder, inv.opts, inv.now);
	if (!schedule.ok) {
		return schedule.message;
	}

	const update: ReminderUpdate = { ...schedule.value };

	if (inv.opts.content !== undefined) {
		const content = normalizeContent(inv.opts.content);
		if (!content.ok) {
			return content.message;
		}
		update.content = content.value;
	}

	let targetPermissions: string | undefined;
	if (inv.opts.channel === undefined) {
		// 通知先を変えない場合も、実行者が今の通知先に投稿できることを確認する。
		// 実行者の権限は実行したチャンネルの分しか分からないため、通知先以外からは通知先の指定を求める
		const check = checkCurrentTarget(inv, reminder, 'edit');
		if (!check.ok) {
			return check.message;
		}
		targetPermissions = inv.actor.permissions;
	} else {
		const target = resolveChannelTarget({
			optionChannelId: inv.opts.channel,
			resolvedChannels: inv.resolved?.channels,
			interactionChannelId: inv.channelId,
			interactionChannelType: inv.channelType,
			memberPermissions: inv.actor.permissions,
			appPermissions: inv.appPermissions,
		});
		if (!target) {
			return '通知先のチャンネルを特定できませんでした。';
		}
		const check = checkChannelTarget(target);
		if (!check.ok) {
			return check.message;
		}
		update.channel_id = target.channelId;
		targetPermissions = target.memberPermissions;

		// 通知先を変える場合は、引き継ぐロールメンションを変更先の権限で確認し直す
		// (ロールがメンション可能かは再指定されない限り分からないため、MENTION_EVERYONE を求める)
		if (
			inv.opts.mention === undefined &&
			reminder.mention_type === 'role' &&
			target.channelId !== reminder.channel_id &&
			!hasPermission(targetPermissions, PermissionFlagsBits.MentionEveryone)
		) {
			return 'ロールへのメンションを新しい通知先に引き継ぐには、mention でロールを指定し直してください。';
		}
	}

	if (inv.opts.mention !== undefined) {
		const mention = resolveMentionOption(inv.opts.mention, reminder.owner_id, inv.resolved);
		if (!mention.ok) {
			return mention.message;
		}
		const check = checkMention({
			mention: mention.value.mention,
			guildId: inv.guildId,
			roleMentionable: mention.value.roleMentionable,
			targetPermissions,
		});
		if (!check.ok) {
			return check.message;
		}
		update.mention_type = mention.value.mention.type;
		update.mention_target_id = mention.value.mention.targetId;
	}

	const paused = reminder.status === 'paused';
	const merged: ReminderRow = { ...reminder, ...update };
	if (!paused) {
		// 終了したリマインダを復活させる場合は、新規登録と同じく件数の上限を確認する
		if (reminder.status === 'ended') {
			const limits = await checkCreationLimits(inv.db, inv.guildId, reminder.owner_id);
			if (!limits.ok) {
				return limits.message;
			}
		}
		if (!computeNextOccurrence(reminderToSchedule(merged), inv.now)) {
			return '条件に合う通知日時がありません。日時・繰り返し・終了日を確認してください。';
		}
		update.status = 'active';
		update.last_error = null;
	} else {
		update.next_run_at = null;
	}

	// 予定の取り消し・内容の更新・次回予定の登録は、読み取り後に変更されていない場合だけ 1 つの batch で行う
	// (途中で失敗しても予定が消えず、同時に行われた通知・編集の結果も上書きしない)。
	// 終了済みからの復活は、件数の上限も UPDATE の条件に含める (確認と更新の間に登録が入っても上限を超えない)
	const reviving = reminder.status === 'ended';
	const { applied } = await updateReminderAndSchedule(inv.db, reminder, update, {
		now: inv.now,
		schedule: !paused,
		condition: reviving
			? withinLimitsCondition(
					{ guildId: reminder.guild_id, ownerId: reminder.owner_id },
					{ perUser: MAX_REMINDERS_PER_USER, perGuild: MAX_REMINDERS_PER_GUILD },
				)
			: undefined,
	});
	const saved = await getReminder(inv.db, reminder.id);
	if (!saved) {
		return notFound(reminder.id);
	}
	if (!applied) {
		if (reviving && saved.revision === reminder.revision) {
			// 読み取り後の変更はなく、件数の条件を満たさなかった
			return `登録できるリマインダの上限に達しているため、リマインダ #${reminder.id} を再開できませんでした。不要なものを /remind delete で削除してください。`;
		}
		return conflictMessage(reminder.id);
	}
	return buildReminderSummary(saved, `✏️ リマインダ #${reminder.id} を更新しました`);
}

function listLine(reminder: ReminderRow, showOwner: boolean): string {
	const parts = [`\`#${reminder.id}\` ${statusLabel(reminder)}`, describeSchedule(reminderToSchedule(reminder))];
	parts.push(`<#${reminder.channel_id}>`);
	if (showOwner) {
		parts.push(`<@${reminder.owner_id}>`);
	}
	if (reminder.status === 'active' && reminder.next_run_at !== null) {
		parts.push(`次回 ${discordTimestamp(reminder.next_run_at, 'R')}`);
	}
	parts.push(truncate(reminder.content.replaceAll(/\s+/g, ' '), LIST_CONTENT_LENGTH));
	return `- ${parts.join(' · ')}`;
}

async function handleList(inv: Invocation): Promise<Reply> {
	const all = inv.opts.all === true;
	if (all && !isModerator(inv.actor)) {
		return 'all を指定できるのはメッセージの管理権限を持つメンバーのみです。';
	}
	const ownerId = all ? undefined : inv.actor.userId;
	const [reminders, total] = await Promise.all([
		listReminders(inv.db, { guildId: inv.guildId, ownerId, limit: LIST_LIMIT }),
		countLiveReminders(inv.db, { guildId: inv.guildId, ownerId }),
	]);
	if (reminders.length === 0) {
		return all ? 'このサーバーにはリマインダがありません。' : '登録しているリマインダはありません。';
	}

	const header = all ? `📋 このサーバーのリマインダ（${total} 件）` : `📋 あなたのリマインダ（${total} 件）`;
	const lines = [header];
	let length = header.length;
	let shown = 0;
	for (const reminder of reminders) {
		const line = listLine(reminder, all);
		const rest = total - shown - 1;
		// 「他 n 件」の行を付けても上限に収まる場合だけ追加する
		const reserve = rest > 0 ? `\n他 ${rest} 件`.length : 0;
		if (length + 1 + line.length + reserve > MESSAGE_MAX_LENGTH) {
			break;
		}
		lines.push(line);
		length += 1 + line.length;
		shown++;
	}
	if (total > shown) {
		lines.push(`他 ${total - shown} 件`);
	}
	return lines.join('\n');
}

async function handleDelete(inv: Invocation): Promise<Reply> {
	const reminder = await findManageableReminder(inv);
	if (!reminder) {
		return notFound(inv.opts.id);
	}
	// ボタンは、その回の通知を送ったチャンネルで外す (通知先を変更した後でも元のメッセージを対象にする)
	const messages = (await listOpenOccurrences(inv.db, reminder.id))
		.filter((occurrence) => occurrence.last_message_id !== null)
		.map((occurrence) => ({
			channelId: occurrence.channel_id ?? reminder.channel_id,
			messageId: occurrence.last_message_id,
		}));
	// ジョブ・通知の記録は外部キーで一緒に削除される
	await deleteReminder(inv.db, reminder.id);
	const message = `🗑️ リマインダ #${reminder.id} を削除しました。`;
	if (messages.length === 0) {
		return message;
	}
	return {
		deferred: async (rest) => {
			for (const { channelId, messageId } of messages) {
				await removeButtons(rest, channelId, messageId);
			}
			return message;
		},
	};
}

async function handlePause(inv: Invocation): Promise<Reply> {
	const reminder = await findManageableReminder(inv);
	if (!reminder) {
		return notFound(inv.opts.id);
	}
	if (reminder.status !== 'active' && reminder.status !== 'error') {
		return `リマインダ #${reminder.id} は一時停止できません（現在: ${statusLabel(reminder)}）。`;
	}
	await inv.db.batch([
		cancelUpcomingStatement(inv.db, reminder.id, inv.now),
		...compact([updateReminderStatement(inv.db, reminder.id, { status: 'paused', next_run_at: null }, inv.now)]),
	]);
	const saved = (await getReminder(inv.db, reminder.id)) ?? reminder;
	return buildReminderSummary(saved, `⏸️ リマインダ #${reminder.id} を一時停止しました`);
}

async function handleResume(inv: Invocation): Promise<Reply> {
	const reminder = await findManageableReminder(inv);
	if (!reminder) {
		return notFound(inv.opts.id);
	}
	if (reminder.status !== 'paused' && reminder.status !== 'error') {
		return `リマインダ #${reminder.id} は再開できません（現在: ${statusLabel(reminder)}）。`;
	}
	// 再開すると Bot が通知先に投稿するため、実行者が通知先に投稿できることを確認する
	const check = checkCurrentTarget(inv, reminder, 'resume');
	if (!check.ok) {
		return check.message;
	}
	// エラー状態から再開する場合に残っている予定と重複しないよう、取り消してから登録し直す。
	// 予定の取り消し・状態の更新・次回予定の登録は、読み取り後に変更されていない場合だけ 1 つの batch で行う
	const { applied, occurrence } = await updateReminderAndSchedule(
		inv.db,
		reminder,
		{ status: 'active', last_error: null },
		{ now: inv.now, schedule: true },
	);
	if (!applied) {
		return conflictMessage(reminder.id);
	}
	const saved = (await getReminder(inv.db, reminder.id)) ?? reminder;
	if (!occurrence) {
		return buildReminderSummary(
			saved,
			`⏹️ リマインダ #${reminder.id} は次回の通知日時がないため、再開せずに終了しました`,
		);
	}
	return buildReminderSummary(saved, `▶️ リマインダ #${reminder.id} を再開しました`);
}

const SUBCOMMANDS: Record<string, (inv: Invocation) => Promise<Reply>> = {
	add: handleAdd,
	in: handleIn,
	edit: handleEdit,
	list: handleList,
	delete: handleDelete,
	pause: handlePause,
	resume: handleResume,
};

// ---- オートコンプリート ----

function autocompleteName(reminder: ReminderRow): string {
	const status = reminder.status === 'active' ? '' : `${statusLabel(reminder).split(' ')[0]} `;
	const content = reminder.content.replaceAll(/\s+/g, ' ');
	return truncate(
		`#${reminder.id} ${status}${describeSchedule(reminderToSchedule(reminder))} ${content}`,
		AUTOCOMPLETE_NAME_LENGTH,
	);
}

/** 入力が ID の前方一致か、本文の部分一致のものに絞る */
function matchesQuery(reminder: ReminderRow, query: string): boolean {
	if (query.length === 0) {
		return true;
	}
	const idQuery = query.replace(/^#/, '');
	if (/^\d+$/.test(idQuery) && String(reminder.id).startsWith(idQuery)) {
		return true;
	}
	return reminder.content.toLowerCase().includes(query.toLowerCase());
}

const RESPONSE_OPTIONS: { allowed_mentions: APIAllowedMentions } = { allowed_mentions: { parse: [] } };

export const remindCommand = factory.autocomplete(
	remindCommandDefinition,
	async (c) => {
		const db = c.env.REMINDER_DB;
		const member = c.interaction.member;
		const guildId = c.interaction.guild_id;
		if (!db || !member || !guildId || c.focused?.name !== 'id') {
			return c.resAutocomplete([]);
		}
		const actor = actorOf(member);
		const query = String(c.focused.value ?? '')
			.normalize('NFKC')
			.trim();
		const reminders = await listReminders(db, {
			guildId,
			ownerId: isModerator(actor) ? undefined : actor.userId,
			limit: MAX_REMINDERS_PER_GUILD,
		});
		return c.resAutocomplete(
			reminders
				.filter((reminder) => matchesQuery(reminder, query))
				.slice(0, AUTOCOMPLETE_LIMIT)
				.map((reminder) => ({ name: autocompleteName(reminder), value: reminder.id })),
		);
	},
	async (c) => {
		const ephemeral = c.flags('EPHEMERAL');
		const db = c.env.REMINDER_DB;
		if (!db) {
			console.error('REMINDER_DB binding is not configured.');
			return ephemeral.res({ content: 'リマインダの保存先が設定されていません。管理者に連絡してください。' });
		}
		const member = c.interaction.member;
		const guildId = c.interaction.guild_id;
		if (!member || !guildId) {
			return ephemeral.res({ content: 'このコマンドはサーバー内でのみ使用できます。' });
		}
		const handler = SUBCOMMANDS[c.sub.command];
		if (!handler) {
			return ephemeral.res({ content: '不明なサブコマンドです。' });
		}

		const data = c.interaction.data;
		const invocation: Invocation = {
			db,
			now: Date.now(),
			guildId,
			actor: actorOf(member),
			channelId: c.interaction.channel?.id ?? c.interaction.channel_id,
			channelType: c.interaction.channel?.type,
			appPermissions: c.interaction.app_permissions,
			resolved: 'resolved' in data ? data.resolved : undefined,
			opts: c.var as RemindOptions,
		};

		let reply: Reply;
		try {
			reply = await handler(invocation);
		} catch (error) {
			console.error(`Unexpected error in /remind ${c.sub.command}:`, error);
			return ephemeral.res({ content: 'エラーが発生しました。時間をおいて再度お試しください。' });
		}
		if (typeof reply === 'string') {
			return ephemeral.res({ content: reply, ...RESPONSE_OPTIONS });
		}
		const { deferred } = reply;
		return ephemeral.resDefer(async (d) => {
			let content: string;
			try {
				content = await deferred(d.rest);
			} catch (error) {
				console.error(`Unexpected error in /remind ${c.sub.command}:`, error);
				content = 'エラーが発生しました。時間をおいて再度お試しください。';
			}
			await d.followup({ content, ...RESPONSE_OPTIONS });
		});
	},
);

export const reminderCommandHandlers = [remindCommand];
