import os
from dataclasses import dataclass

MAX_WISHES = 20
MAX_WISH_LEN = 300
MAX_TITLE_LEN = 100
MIN_PLAYERS = 3
MAX_PLAYERS = 50  # чтобы клавиатуры укладывались в лимит Telegram (100 кнопок)


@dataclass(frozen=True)
class Config:
    token: str
    db_path: str = "santa.db"

    @classmethod
    def from_env(cls) -> "Config":
        token = os.environ.get("BOT_TOKEN", "").strip()
        if not token:
            raise SystemExit("Не задан BOT_TOKEN (см. .env.example)")
        return cls(token=token, db_path=os.environ.get("DB_PATH", "santa.db"))
