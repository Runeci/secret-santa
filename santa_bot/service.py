"""Бизнес-правила игры. Не знает про Telegram: только БД и проверки."""
import enum
import sqlite3

from . import config
from .db import Database
from .draw import DrawImpossible, make_draw


class UserError(Exception):
    """Ошибка, текст которой можно показать пользователю как есть."""


class JoinResult(enum.Enum):
    JOINED = "joined"
    ALREADY = "already"
    CLOSED = "closed"
    FULL = "full"
    NOT_FOUND = "not_found"


def clean_text(text: str | None, limit: int, what: str) -> str:
    text = (text or "").strip()
    if not text:
        raise UserError(f"{what} не может быть пустым.")
    if len(text) > limit:
        raise UserError(f"Слишком длинно: {len(text)} символов, максимум {limit}. Сократите, пожалуйста.")
    return text


class Service:
    def __init__(self, db: Database):
        self.db = db

    # --- доступ -------------------------------------------------------
    def game_for_player(self, game_id: int, user_id: int) -> sqlite3.Row:
        game = self.db.get_game(game_id)
        if game is None or not self.db.is_player(game_id, user_id):
            raise UserError("Вы не участвуете в этой игре.")
        return game

    def game_for_organizer(self, game_id: int, user_id: int) -> sqlite3.Row:
        game = self.db.get_game(game_id)
        if game is None or game["organizer_id"] != user_id:
            raise UserError("Это действие доступно только организатору игры.")
        return game

    def organizer_open_game(self, game_id: int, user_id: int) -> sqlite3.Row:
        game = self.game_for_organizer(game_id, user_id)
        if game["status"] != "open":
            raise UserError("Жеребьёвка уже проведена, изменить это нельзя.")
        return game

    # --- игры и участники --------------------------------------------
    def create_game(self, title: str | None, user_id: int, user_name: str) -> sqlite3.Row:
        title = clean_text(title, config.MAX_TITLE_LEN, "Название")
        return self.db.create_game(title, user_id, user_name)

    def join(self, code: str, user_id: int, user_name: str) -> tuple[JoinResult, sqlite3.Row | None]:
        game = self.db.get_game_by_code(code)
        if game is None:
            return JoinResult.NOT_FOUND, None
        if self.db.is_player(game["id"], user_id):
            return JoinResult.ALREADY, game
        if game["status"] != "open":
            return JoinResult.CLOSED, game
        if len(self.db.get_players(game["id"])) >= config.MAX_PLAYERS:
            return JoinResult.FULL, game
        self.db.add_player(game["id"], user_id, user_name)
        return JoinResult.JOINED, game

    def remove_player(self, game_id: int, organizer_id: int, target_id: int) -> sqlite3.Row:
        self.organizer_open_game(game_id, organizer_id)
        if target_id == organizer_id:
            raise UserError("Организатор не может убрать сам себя.")
        player = self.db.get_player(game_id, target_id)
        if player is None:
            raise UserError("Этого участника уже нет в игре.")
        self.db.remove_player(game_id, target_id)
        return player

    def leave(self, game_id: int, user_id: int) -> None:
        game = self.game_for_player(game_id, user_id)
        if game["organizer_id"] == user_id:
            raise UserError("Организатор не может выйти из своей игры.")
        if game["status"] != "open":
            raise UserError("Жеребьёвка уже проведена, выйти нельзя.")
        self.db.remove_player(game_id, user_id)

    # --- подарки ------------------------------------------------------
    def add_wish(self, game_id: int, user_id: int, text: str | None) -> int:
        self.game_for_player(game_id, user_id)
        text = clean_text(text, config.MAX_WISH_LEN, "Пункт")
        if len(self.db.get_wishes(game_id, user_id)) >= config.MAX_WISHES:
            raise UserError(f"В списке уже {config.MAX_WISHES} пунктов — это максимум. Удалите что-нибудь.")
        return self.db.add_wish(game_id, user_id, text)

    def _own_wish(self, game_id: int, user_id: int, wish_id: int) -> sqlite3.Row:
        self.game_for_player(game_id, user_id)
        wish = self.db.get_wish(wish_id)
        if wish is None or wish["game_id"] != game_id or wish["user_id"] != user_id:
            raise UserError("Такого пункта уже нет.")
        return wish

    def edit_wish(self, game_id: int, user_id: int, wish_id: int, text: str | None) -> None:
        self._own_wish(game_id, user_id, wish_id)
        self.db.update_wish(wish_id, clean_text(text, config.MAX_WISH_LEN, "Пункт"))

    def delete_wish(self, game_id: int, user_id: int, wish_id: int) -> None:
        self._own_wish(game_id, user_id, wish_id)
        self.db.delete_wish(wish_id)

    def santa_of(self, game_id: int, user_id: int) -> int | None:
        """Кто дарит этому человеку (для анонимных уведомлений). None до жеребьёвки."""
        return self.db.get_giver(game_id, user_id)

    # --- правила ------------------------------------------------------
    def create_rule(self, game_id: int, organizer_id: int, members: set[int]) -> int:
        self.organizer_open_game(game_id, organizer_id)
        if len(members) < 2:
            raise UserError("В группе должно быть минимум 2 человека.")
        valid = {p["user_id"] for p in self.db.get_players(game_id)}
        if not members <= valid:
            raise UserError("Некоторых выбранных людей уже нет в игре.")
        for _, existing in self.db.get_rules(game_id):
            if set(existing) == members:
                raise UserError("Такое правило уже есть.")
        return self.db.add_rule(game_id, sorted(members))

    def delete_rule(self, game_id: int, organizer_id: int, rule_id: int) -> None:
        self.organizer_open_game(game_id, organizer_id)
        self.db.delete_rule(game_id, rule_id)

    # --- жеребьёвка ---------------------------------------------------
    def run_draw(self, game_id: int, organizer_id: int) -> dict[int, int]:
        """Проводит жеребьёвку. DrawImpossible — если с правилами решения нет."""
        self.organizer_open_game(game_id, organizer_id)
        players = [p["user_id"] for p in self.db.get_players(game_id)]
        if len(players) < config.MIN_PLAYERS:
            raise UserError(f"Для жеребьёвки нужно минимум {config.MIN_PLAYERS} участника.")
        rules = [members for _, members in self.db.get_rules(game_id)]
        assignment = make_draw(players, rules)  # может бросить DrawImpossible
        if not self.db.save_draw(game_id, assignment):
            raise UserError("Жеребьёвка уже проведена.")
        return assignment


__all__ = ["Service", "UserError", "JoinResult", "DrawImpossible"]
