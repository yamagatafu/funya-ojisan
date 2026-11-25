-- 通知を送信したチャンネル (通知先を変更した後でも、送信済みのメッセージのボタンを外せるようにする)
ALTER TABLE reminder_occurrences ADD COLUMN channel_id TEXT;
