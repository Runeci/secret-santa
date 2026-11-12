CREATE TABLE games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    organizer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
);
CREATE TABLE players (
    game_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, user_id)
);
CREATE INDEX players_by_user ON players(user_id);
CREATE TABLE wishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX wishes_by_user ON wishes(game_id, user_id);
CREATE TABLE rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL
);
CREATE TABLE rule_members (
    rule_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (rule_id, user_id)
);
CREATE TABLE assignments (
    game_id INTEGER NOT NULL,
    giver_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    PRIMARY KEY (game_id, giver_id)
);
CREATE INDEX assignments_by_receiver ON assignments(game_id, receiver_id);
-- Состояние диалога (ввод названия/подарка/выбор группы): воркеры не хранят память между запросами.
CREATE TABLE user_state (
    user_id INTEGER PRIMARY KEY,
    state TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
);
