"""Тексты (HTML parse_mode). Всё пользовательское обязательно экранируется."""
import html
import sqlite3
from collections.abc import Sequence

from . import config

WELCOME = (
    "🎅 <b>Тайный Санта</b>\n\n"
    "Создайте игру и разошлите друзьям ссылку-приглашение — или перейдите по "
    "ссылке, которую вам прислали."
)
NO_GAMES = "У вас пока нет игр. Создайте свою или перейдите по ссылке-приглашению."
ASK_TITLE = "Как назовём игру? Например: «Новый год в офисе». Отправьте название сообщением."
ASK_WISH = (
    f"Напишите один подарок, который хотели бы получить "
    f"(до {config.MAX_WISH_LEN} символов). Можно ссылку, размер, цвет — всё, что поможет Санте."
)
CANCELLED = "Отменено."
UNKNOWN_TEXT = "Не понял 🤔 Откройте меню: /start"


def e(text: object) -> str:
    return html.escape(str(text))


def player_name(p: sqlite3.Row) -> str:
    return e(p["name"])


def display_name(full_name: str, username: str | None) -> str:
    return f"{full_name} (@{username})" if username else full_name


def wishlist(wishes: Sequence[sqlite3.Row]) -> str:
    if not wishes:
        return "<i>список пока пуст</i>"
    return "\n".join(f"{i}. {e(w['text'])}" for i, w in enumerate(wishes, 1))


def game_menu(game: sqlite3.Row, players: int, is_org: bool) -> str:
    status = "ждём участников" if game["status"] == "open" else "жеребьёвка проведена ✅"
    role = " · вы организатор" if is_org else ""
    return f"🎄 <b>{e(game['title'])}</b>{role}\nУчастников: {players} · {status}"


def my_wishlist(wishes: Sequence[sqlite3.Row], drawn: bool) -> str:
    head = f"📝 <b>Ваш список подарков</b> ({len(wishes)}/{config.MAX_WISHES})\n\n{wishlist(wishes)}"
    tail = "\n\nНажмите на пункт, чтобы изменить или удалить его."
    if drawn:
        tail += "\nВаш Санта получит уведомление об изменениях (анонимно)."
    return head + (tail if wishes else "")


def invite(link: str) -> str:
    return f"🔗 Ссылка-приглашение:\n{e(link)}\n\nОтправьте её тем, кто будет участвовать."


def assignment(game_title: str, receiver_name: str, wishes: Sequence[sqlite3.Row]) -> str:
    return (
        f"🎁 <b>{e(game_title)}</b>\n\n"
        f"Вы — Тайный Санта для: <b>{e(receiver_name)}</b>\n\n"
        f"Что хочет получить:\n{wishlist(wishes)}\n\n"
        "Это секрет — никому не рассказывайте 🤫"
    )


def wishes_updated(receiver_name: str, wishes: Sequence[sqlite3.Row]) -> str:
    return (
        f"🔔 <b>{e(receiver_name)}</b> обновил(а) список желаний. Актуальный список:\n\n"
        f"{wishlist(wishes)}"
    )


def draw_impossible(title: str) -> str:
    return (
        f"😔 С текущими правилами жеребьёвка в игре «{e(title)}» невозможна: "
        "не получается раздать подарки так, чтобы никто не достался себе или "
        "человеку из своей группы.\n\nУдалите часть правил «кто кому не дарит» "
        "и попробуйте снова."
    )
