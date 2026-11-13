-- Дедлайн игры: локальная дата (YYYY-MM-DD) и сдвиг часового пояса организатора от UTC в часах.
ALTER TABLE games ADD COLUMN deadline_date TEXT;
ALTER TABLE games ADD COLUMN tz_offset INTEGER NOT NULL DEFAULT 0;
-- Локальный день, когда напоминания уже отправлены (чтобы не слать дважды при почасовом запуске).
ALTER TABLE games ADD COLUMN last_reminded_day TEXT;
