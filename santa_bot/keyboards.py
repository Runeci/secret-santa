import sqlite3
from collections.abc import Sequence

from aiogram.types import InlineKeyboardButton as B
from aiogram.types import InlineKeyboardMarkup as Markup


def _kb(rows: list[list[B]]) -> Markup:
    return Markup(inline_keyboard=rows)


def _short(text: str, n: int = 40) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def games_list(games: Sequence[sqlite3.Row]) -> Markup:
    rows = [[B(text=f"🎄 {_short(g['title'])}", callback_data=f"g:{g['id']}")] for g in games]
    rows.append([B(text="➕ Создать игру", callback_data="new")])
    return _kb(rows)


def game_menu(game: sqlite3.Row, is_org: bool, wish_count: int, multi: bool) -> Markup:
    gid = game["id"]
    drawn = game["status"] == "drawn"
    rows = [
        [B(text=f"📝 Мой список ({wish_count})", callback_data=f"w:{gid}")],
        [B(text="➕ Добавить подарок", callback_data=f"wa:{gid}")],
    ]
    if drawn:
        rows.append([B(text="🎯 Кому я дарю", callback_data=f"to:{gid}")])
    if is_org:
        rows.append([B(text="⚙️ Управление игрой", callback_data=f"m:{gid}")])
    elif not drawn:
        rows.append([B(text="🚪 Выйти из игры", callback_data=f"lv:{gid}")])
    rows.append([B(text="⬅️ Мои игры" if multi else "➕ Создать игру", callback_data="menu" if multi else "new")])
    return _kb(rows)


def back(gid: int) -> Markup:
    return _kb([[B(text="⬅️ В меню игры", callback_data=f"g:{gid}")]])


def my_wishlist(gid: int, wishes: Sequence[sqlite3.Row]) -> Markup:
    rows = [
        [B(text=f"{i}. {_short(w['text'])}", callback_data=f"wi:{gid}:{w['id']}")]
        for i, w in enumerate(wishes, 1)
    ]
    rows.append([B(text="➕ Добавить подарок", callback_data=f"wa:{gid}")])
    rows.append([B(text="⬅️ В меню игры", callback_data=f"g:{gid}")])
    return _kb(rows)


def wish_item(gid: int, wid: int) -> Markup:
    return _kb([
        [B(text="✏️ Изменить", callback_data=f"we:{gid}:{wid}"),
         B(text="🗑 Удалить", callback_data=f"wd:{gid}:{wid}")],
        [B(text="⬅️ К списку", callback_data=f"w:{gid}")],
    ])


def after_wish(gid: int) -> Markup:
    return _kb([
        [B(text="➕ Добавить ещё", callback_data=f"wa:{gid}")],
        [B(text="📝 Мой список", callback_data=f"w:{gid}")],
        [B(text="⬅️ В меню игры", callback_data=f"g:{gid}")],
    ])


def cancel_input(gid: int) -> Markup:
    return _kb([[B(text="✖️ Отмена", callback_data=f"g:{gid}")]])


def manage(gid: int, open_: bool) -> Markup:
    rows = [
        [B(text="👥 Участники", callback_data=f"mp:{gid}")],
        [B(text="🚫 Правила «кто кому не дарит»", callback_data=f"mr:{gid}")],
        [B(text="🔗 Ссылка-приглашение", callback_data=f"ml:{gid}")],
    ]
    if open_:
        rows.append([B(text="🎲 Провести жеребьёвку", callback_data=f"md:{gid}")])
    rows.append([B(text="⬅️ В меню игры", callback_data=f"g:{gid}")])
    return _kb(rows)


def back_manage(gid: int) -> Markup:
    return _kb([[B(text="⬅️ Управление", callback_data=f"m:{gid}")]])


def players(gid: int, plist: Sequence[sqlite3.Row], organizer_id: int, open_: bool) -> Markup:
    rows = []
    if open_:
        rows = [
            [B(text=f"❌ Убрать: {_short(p['name'], 30)}", callback_data=f"mpr:{gid}:{p['user_id']}")]
            for p in plist if p["user_id"] != organizer_id
        ]
    rows.append([B(text="⬅️ Управление", callback_data=f"m:{gid}")])
    return _kb(rows)


def confirm(yes: str, no: str, yes_text: str = "✅ Да", no_text: str = "⬅️ Нет") -> Markup:
    return _kb([[B(text=yes_text, callback_data=yes), B(text=no_text, callback_data=no)]])


def rules(gid: int, rule_ids: Sequence[int], open_: bool) -> Markup:
    rows = []
    if open_:
        rows = [[B(text=f"🗑 Удалить правило {i}", callback_data=f"mrd:{gid}:{rid}")]
                for i, rid in enumerate(rule_ids, 1)]
        rows.append([B(text="➕ Добавить правило", callback_data=f"mra:{gid}")])
    rows.append([B(text="⬅️ Управление", callback_data=f"m:{gid}")])
    return _kb(rows)


def rule_picker(gid: int, plist: Sequence[sqlite3.Row], selected: set[int]) -> Markup:
    rows = [
        [B(text=("✅ " if p["user_id"] in selected else "⬜ ") + _short(p["name"], 35),
           callback_data=f"mrt:{gid}:{p['user_id']}")]
        for p in plist
    ]
    rows.append([B(text=f"💾 Сохранить ({len(selected)})", callback_data=f"mrs:{gid}")])
    rows.append([B(text="✖️ Отмена", callback_data=f"mr:{gid}")])
    return _kb(rows)


def draw_retry(gid: int) -> Markup:
    return _kb([
        [B(text="🚫 Открыть правила", callback_data=f"mr:{gid}")],
        [B(text="⬅️ Управление", callback_data=f"m:{gid}")],
    ])
