import secrets
import sqlite3
import time
from collections.abc import Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    organizer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',      -- open | drawn
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, user_id)
);
CREATE TABLE IF NOT EXISTS wishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wishes_by_user ON wishes(game_id, user_id);
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS rule_members (
    rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (rule_id, user_id)
);
CREATE TABLE IF NOT EXISTS assignments (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    giver_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    PRIMARY KEY (game_id, giver_id)
);
"""


class Database:
    def __init__(self, path: str = ":memory:"):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # --- игры ---------------------------------------------------------
    def create_game(self, title: str, organizer_id: int, organizer_name: str) -> sqlite3.Row:
        code = secrets.token_urlsafe(6)
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO games(code, title, organizer_id, created_at) VALUES (?,?,?,?)",
                (code, title, organizer_id, int(time.time())),
            )
            gid = cur.lastrowid
            self.conn.execute(
                "INSERT INTO players(game_id, user_id, name, joined_at) VALUES (?,?,?,?)",
                (gid, organizer_id, organizer_name, int(time.time())),
            )
        return self.get_game(gid)

    def get_game(self, game_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()

    def get_game_by_code(self, code: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM games WHERE code=?", (code,)).fetchone()

    def games_of_user(self, user_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT g.* FROM games g JOIN players p ON p.game_id=g.id "
            "WHERE p.user_id=? ORDER BY g.id",
            (user_id,),
        ).fetchall()

    # --- участники ----------------------------------------------------
    def add_player(self, game_id: int, user_id: int, name: str) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO players(game_id, user_id, name, joined_at) VALUES (?,?,?,?)",
                (game_id, user_id, name, int(time.time())),
            )

    def update_player_name(self, user_id: int, name: str) -> None:
        with self.conn:
            self.conn.execute("UPDATE players SET name=? WHERE user_id=?", (name, user_id))

    def get_players(self, game_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM players WHERE game_id=? ORDER BY joined_at, user_id", (game_id,)
        ).fetchall()

    def is_player(self, game_id: int, user_id: int) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM players WHERE game_id=? AND user_id=?", (game_id, user_id)
        ).fetchone() is not None

    def get_player(self, game_id: int, user_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM players WHERE game_id=? AND user_id=?", (game_id, user_id)
        ).fetchone()

    def remove_player(self, game_id: int, user_id: int) -> None:
        """Убирает участника, его подарки и его из правил; правила < 2 человек удаляются."""
        with self.conn:
            self.conn.execute(
                "DELETE FROM players WHERE game_id=? AND user_id=?", (game_id, user_id)
            )
            self.conn.execute(
                "DELETE FROM wishes WHERE game_id=? AND user_id=?", (game_id, user_id)
            )
            self.conn.execute(
                "DELETE FROM rule_members WHERE user_id=? AND rule_id IN "
                "(SELECT id FROM rules WHERE game_id=?)",
                (user_id, game_id),
            )
            self.conn.execute(
                "DELETE FROM rules WHERE game_id=? AND id NOT IN "
                "(SELECT rule_id FROM rule_members GROUP BY rule_id HAVING COUNT(*) >= 2)",
                (game_id,),
            )

    # --- подарки ------------------------------------------------------
    def get_wishes(self, game_id: int, user_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM wishes WHERE game_id=? AND user_id=? ORDER BY id", (game_id, user_id)
        ).fetchall()

    def get_wish(self, wish_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM wishes WHERE id=?", (wish_id,)).fetchone()

    def add_wish(self, game_id: int, user_id: int, text: str) -> int:
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO wishes(game_id, user_id, text) VALUES (?,?,?)",
                (game_id, user_id, text),
            )
        return cur.lastrowid

    def update_wish(self, wish_id: int, text: str) -> None:
        with self.conn:
            self.conn.execute("UPDATE wishes SET text=? WHERE id=?", (text, wish_id))

    def delete_wish(self, wish_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM wishes WHERE id=?", (wish_id,))

    # --- правила ------------------------------------------------------
    def add_rule(self, game_id: int, members: Iterable[int]) -> int:
        with self.conn:
            cur = self.conn.execute("INSERT INTO rules(game_id) VALUES (?)", (game_id,))
            rid = cur.lastrowid
            self.conn.executemany(
                "INSERT INTO rule_members(rule_id, user_id) VALUES (?,?)",
                [(rid, m) for m in members],
            )
        return rid

    def get_rules(self, game_id: int) -> list[tuple[int, list[int]]]:
        rows = self.conn.execute(
            "SELECT r.id AS rid, m.user_id AS uid FROM rules r "
            "JOIN rule_members m ON m.rule_id=r.id WHERE r.game_id=? ORDER BY r.id, m.user_id",
            (game_id,),
        ).fetchall()
        rules: dict[int, list[int]] = {}
        for row in rows:
            rules.setdefault(row["rid"], []).append(row["uid"])
        return list(rules.items())

    def get_rule(self, game_id: int, rule_id: int) -> list[int] | None:
        for rid, members in self.get_rules(game_id):
            if rid == rule_id:
                return members
        return None

    def delete_rule(self, game_id: int, rule_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM rules WHERE id=? AND game_id=?", (rule_id, game_id))

    # --- жеребьёвка ---------------------------------------------------
    def save_draw(self, game_id: int, assignment: dict[int, int]) -> bool:
        """Атомарно сохраняет результат и закрывает игру. False, если уже разыграна."""
        with self.conn:
            cur = self.conn.execute(
                "UPDATE games SET status='drawn' WHERE id=? AND status='open'", (game_id,)
            )
            if cur.rowcount == 0:
                return False
            self.conn.executemany(
                "INSERT INTO assignments(game_id, giver_id, receiver_id) VALUES (?,?,?)",
                [(game_id, g, r) for g, r in assignment.items()],
            )
        return True

    def get_receiver(self, game_id: int, giver_id: int) -> int | None:
        row = self.conn.execute(
            "SELECT receiver_id FROM assignments WHERE game_id=? AND giver_id=?",
            (game_id, giver_id),
        ).fetchone()
        return row["receiver_id"] if row else None

    def get_giver(self, game_id: int, receiver_id: int) -> int | None:
        row = self.conn.execute(
            "SELECT giver_id FROM assignments WHERE game_id=? AND receiver_id=?",
            (game_id, receiver_id),
        ).fetchone()
        return row["giver_id"] if row else None

    def get_assignments(self, game_id: int) -> dict[int, int]:
        rows = self.conn.execute(
            "SELECT giver_id, receiver_id FROM assignments WHERE game_id=?", (game_id,)
        ).fetchall()
        return {r["giver_id"]: r["receiver_id"] for r in rows}
