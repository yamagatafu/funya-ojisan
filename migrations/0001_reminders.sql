-- リマインダ定義
CREATE TABLE reminders (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	content TEXT NOT NULL,
	-- コンテキストメニューから作成した場合の元メッセージ
	source_message_url TEXT,
	-- 'self' | 'user' | 'role' | 'none'
	mention_type TEXT NOT NULL,
	mention_target_id TEXT,
	-- 'once' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly_day' | 'monthly_last' | 'monthly_nth_weekday'
	schedule_type TEXT NOT NULL,
	-- 0:00 からの経過分 (JST)
	time_of_day INTEGER NOT NULL,
	-- once の実行日時 (UTC ms)
	once_at INTEGER,
	-- bit0=日 ... bit6=土
	weekdays_mask INTEGER,
	day_of_month INTEGER,
	-- 1-5 (5 = 最終週)
	nth_week INTEGER,
	-- 開始日 (YYYY-MM-DD, JST)。隔週の起点週を兼ねる
	start_date TEXT,
	-- 'notify' | 'skip' | 'shift'
	holiday_policy TEXT NOT NULL DEFAULT 'notify',
	pre_notify_minutes INTEGER,
	nag_interval_minutes INTEGER,
	nag_max_count INTEGER,
	-- 終了日 (YYYY-MM-DD, JST, 当日を含む)
	end_date TEXT,
	-- 残り回数 (NULL = 無制限)
	remaining_count INTEGER,
	-- 'active' | 'paused' | 'ended' | 'error'
	status TEXT NOT NULL,
	last_error TEXT,
	-- 次回の本通知 (UTC ms)
	next_run_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK (schedule_type != 'once' OR holiday_policy = 'notify')
);
CREATE INDEX idx_reminders_owner ON reminders (guild_id, owner_id);
CREATE INDEX idx_reminders_status ON reminders (status, updated_at);

-- 1 回分の通知 (完了・スヌーズ・再通知の単位)
CREATE TABLE reminder_occurrences (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	reminder_id INTEGER NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
	scheduled_at INTEGER NOT NULL,
	-- ボタンが付いている最新の通知メッセージ
	last_message_id TEXT,
	nag_count INTEGER NOT NULL DEFAULT 0,
	-- 'open' | 'completed' | 'superseded'
	state TEXT NOT NULL,
	completed_by TEXT,
	completed_at INTEGER
);
CREATE INDEX idx_occurrences_reminder ON reminder_occurrences (reminder_id, state);

-- 送信ジョブ
CREATE TABLE reminder_jobs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	reminder_id INTEGER NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
	occurrence_id INTEGER REFERENCES reminder_occurrences (id) ON DELETE CASCADE,
	-- 'pre' | 'main' | 'snooze' | 'nag'
	kind TEXT NOT NULL,
	run_at INTEGER NOT NULL,
	-- 対象となる本通知の予定時刻
	scheduled_at INTEGER NOT NULL,
	-- 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled'
	status TEXT NOT NULL,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	locked_at INTEGER,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_due ON reminder_jobs (status, run_at);
CREATE INDEX idx_jobs_reminder ON reminder_jobs (reminder_id, status);
