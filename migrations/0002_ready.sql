-- Отметка «мой список готов»: жеребьёвка возможна, только когда она стоит у всех участников.
ALTER TABLE players ADD COLUMN ready INTEGER NOT NULL DEFAULT 0;
