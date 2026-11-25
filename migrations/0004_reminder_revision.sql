-- 更新のたびに 1 ずつ増えるリビジョン (読み取り後に変更されていないかの検知に使う。
-- updated_at はミリ秒単位の時刻のため、別々の更新で同じ値になり得る)
ALTER TABLE reminders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
