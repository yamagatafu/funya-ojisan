-- 再通知・スヌーズの送信後の処理が失敗して再試行されたときに、同じ通知を再送しないための記録
ALTER TABLE reminder_jobs ADD COLUMN sent_message_id TEXT;
