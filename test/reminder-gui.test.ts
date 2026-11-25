import { ApplicationCommandOptionType, ComponentType, InteractionType } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { reminderCommandHandlers } from '../src/handlers/reminder-commands.ts';
import {
	BASE_FIELD,
	buildBaseModal,
	buildDetailButtons,
	formatBaseModalState,
	parseBaseModalState,
	parseBaseModalValues,
} from '../src/reminder/gui.ts';
import { createTestDb } from './helpers/d1.ts';
import {
	baseInteractionFields,
	CHANNEL_ID,
	createApp,
	createEnv,
	createExecutionContext,
	createInteractionRequest,
} from './helpers/interaction.ts';

const FIELD_IDS = (modal: ReturnType<typeof buildBaseModal>) =>
	modal.components.map((row) => ('component' in row ? row.component.custom_id : undefined));

describe('base modal state', () => {
	it('round-trips new and edit states', () => {
		expect(parseBaseModalState(formatBaseModalState({ mode: 'new', repeat: 'weekly' }))).toEqual({
			mode: 'new',
			repeat: 'weekly',
		});
		expect(parseBaseModalState(formatBaseModalState({ mode: 'edit', repeat: 'once', reminderId: 12 }))).toEqual({
			mode: 'edit',
			repeat: 'once',
			reminderId: 12,
		});
	});

	it('rejects malformed states', () => {
		for (const value of ['', 'new', 'new:hourly', 'edit:once', 'edit:once:0', 'new:once:3', 'x:once']) {
			expect(parseBaseModalState(value)).toBeNull();
		}
	});
});

describe('buildBaseModal', () => {
	it('builds fields for each repeat type within 5 components', () => {
		expect(FIELD_IDS(buildBaseModal({ mode: 'new', repeat: 'once' }, {}))).toEqual([
			BASE_FIELD.content,
			BASE_FIELD.date,
			BASE_FIELD.time,
			BASE_FIELD.channel,
		]);
		expect(FIELD_IDS(buildBaseModal({ mode: 'new', repeat: 'daily' }, {}))).toEqual([
			BASE_FIELD.content,
			BASE_FIELD.time,
			BASE_FIELD.channel,
		]);
		expect(FIELD_IDS(buildBaseModal({ mode: 'new', repeat: 'weekly' }, {}))).toEqual([
			BASE_FIELD.content,
			BASE_FIELD.time,
			BASE_FIELD.weekdays,
			BASE_FIELD.channel,
		]);
		expect(FIELD_IDS(buildBaseModal({ mode: 'new', repeat: 'monthly_day' }, {}))).toEqual([
			BASE_FIELD.content,
			BASE_FIELD.time,
			BASE_FIELD.day,
			BASE_FIELD.channel,
		]);
		expect(FIELD_IDS(buildBaseModal({ mode: 'new', repeat: 'monthly_nth_weekday' }, {}))).toEqual([
			BASE_FIELD.content,
			BASE_FIELD.time,
			BASE_FIELD.nth,
			BASE_FIELD.weekday,
			BASE_FIELD.channel,
		]);
	});

	it('fills defaults for editing', () => {
		const modal = buildBaseModal(
			{ mode: 'edit', repeat: 'monthly_nth_weekday', reminderId: 7 },
			{ content: '会議', time: '10:00', nth: 5, weekdaysMask: 1 << 5, channelId: CHANNEL_ID },
		);
		expect(modal.custom_id).toBe('remind_base_modal;edit:monthly_nth_weekday:7');
		expect(modal.title).toBe('リマインダを編集（毎月第n曜日）');
		const [content, time, nth, weekday, channel] = modal.components.map((row) =>
			'component' in row ? row.component : undefined,
		);
		expect(content).toMatchObject({ value: '会議' });
		expect(time).toMatchObject({ value: '10:00' });
		expect(nth).toMatchObject({ options: expect.arrayContaining([{ value: '5', label: '最終', default: true }]) });
		expect(weekday).toMatchObject({
			options: expect.arrayContaining([{ value: '5', label: '金', default: true }]),
		});
		expect(channel).toMatchObject({ default_values: [{ id: CHANNEL_ID, type: 'channel' }] });
	});
});

describe('parseBaseModalValues', () => {
	it('converts weekly checkbox values to weekday text', () => {
		expect(
			parseBaseModalValues('weekly', {
				content: ' ゴミ出し ',
				time: '07:30',
				weekdays: ['5', '2'],
				channel: [CHANNEL_ID],
			}),
		).toEqual({
			content: ' ゴミ出し ',
			channel: CHANNEL_ID,
			schedule: { repeat: 'weekly', time: '07:30', weekdays: '火金' },
		});
	});

	it('converts nth weekday radios and monthly day text', () => {
		expect(parseBaseModalValues('monthly_nth_weekday', { time: '09:00', nth: '2', weekday: '2' }).schedule).toEqual(
			{
				repeat: 'monthly_nth_weekday',
				time: '09:00',
				nth: 2,
				weekdays: '火',
			},
		);
		expect(parseBaseModalValues('monthly_day', { time: '09:00', day: '１５' }).schedule.day).toBe(15);
		expect(parseBaseModalValues('monthly_day', { time: '09:00', day: 'abc' }).schedule.day).toBeNaN();
	});

	it('treats blank text as unspecified', () => {
		expect(parseBaseModalValues('once', { content: '  ', time: '09:00', date: '' })).toEqual({
			content: undefined,
			channel: undefined,
			schedule: { repeat: 'once', time: '09:00', date: undefined },
		});
	});
});

describe('buildDetailButtons', () => {
	it('shows the period button only for repeating reminders', () => {
		const ids = (row: ReturnType<typeof buildDetailButtons>) => row.components.map((button) => button.custom_id);
		expect(ids(buildDetailButtons({ id: 3, schedule_type: 'once' }))).toEqual(['remind_notify_settings;3']);
		expect(ids(buildDetailButtons({ id: 3, schedule_type: 'weekly' }))).toEqual([
			'remind_notify_settings;3',
			'remind_period_settings;3',
		]);
	});
});

describe('/remind new', () => {
	it('replies with the repeat select menu', async () => {
		const db = createTestDb();
		const app = createApp(reminderCommandHandlers);
		const { ctx } = createExecutionContext();
		const response = await app.fetch(
			createInteractionRequest({
				...baseInteractionFields({}),
				type: InteractionType.ApplicationCommand,
				data: {
					id: '1',
					name: 'remind',
					type: 1,
					options: [{ name: 'new', type: ApplicationCommandOptionType.Subcommand, options: [] }],
				},
			}),
			createEnv(db),
			ctx,
		);
		const body = (await response.json()) as {
			data: {
				flags: number;
				content: string;
				components: { components: { type: number; custom_id: string }[] }[];
			};
		};
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain('繰り返しを選んでください');
		expect(body.data.components[0]?.components[0]).toMatchObject({
			type: ComponentType.StringSelect,
			custom_id: 'remind_new_repeat',
		});
	});
});
