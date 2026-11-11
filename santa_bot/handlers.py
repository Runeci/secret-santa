import logging
from collections.abc import Awaitable, Callable

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import Command, CommandObject, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message, User

from . import config, keyboards as kb, texts
from .service import DrawImpossible, JoinResult, Service, UserError

log = logging.getLogger(__name__)


class Form(StatesGroup):
    title = State()
    wish_add = State()
    wish_edit = State()
    rule = State()


def _name(user: User) -> str:
    return texts.display_name(user.full_name, user.username)


async def safe_send(bot: Bot, chat_id: int, text: str, markup: InlineKeyboardMarkup | None = None) -> bool:
    try:
        await bot.send_message(chat_id, text, reply_markup=markup)
        return True
    except TelegramAPIError as exc:  # заблокировал бота и т.п.
        log.warning("Не удалось отправить сообщение %s: %s", chat_id, exc)
        return False


async def show(ev: Message | CallbackQuery, text: str, markup: InlineKeyboardMarkup | None = None) -> None:
    """Редактирует сообщение с кнопкой или отправляет новое в ответ на текст."""
    if isinstance(ev, CallbackQuery):
        try:
            await ev.message.edit_text(text, reply_markup=markup)
        except TelegramBadRequest as exc:
            if "not modified" in str(exc):
                return
            await ev.bot.send_message(ev.from_user.id, text, reply_markup=markup)
    else:
        await ev.answer(text, reply_markup=markup)


def build_router(svc: Service) -> Router:
    router = Router()
    db = svc.db

    # ------------------------------------------------------------ экраны
    async def screen_games(ev: Message | CallbackQuery, uid: int, force_list: bool = False) -> None:
        games = db.games_of_user(uid)
        if len(games) == 1 and not force_list:
            return await screen_game(ev, uid, games[0]["id"])
        if not games:
            return await show(ev, texts.WELCOME + "\n\n" + texts.NO_GAMES, kb.games_list([]))
        await show(ev, "🎅 <b>Ваши игры</b>", kb.games_list(games))

    async def screen_game(ev: Message | CallbackQuery, uid: int, gid: int) -> None:
        game = svc.game_for_player(gid, uid)
        is_org = game["organizer_id"] == uid
        n = len(db.get_players(gid))
        wishes = len(db.get_wishes(gid, uid))
        multi = len(db.games_of_user(uid)) > 1
        await show(ev, texts.game_menu(game, n, is_org), kb.game_menu(game, is_org, wishes, multi))

    async def screen_wishlist(ev: CallbackQuery, uid: int, gid: int) -> None:
        game = svc.game_for_player(gid, uid)
        wishes = db.get_wishes(gid, uid)
        await show(ev, texts.my_wishlist(wishes, game["status"] == "drawn"), kb.my_wishlist(gid, wishes))

    async def screen_manage(ev: CallbackQuery, uid: int, gid: int) -> None:
        game = svc.game_for_organizer(gid, uid)
        open_ = game["status"] == "open"
        text = texts.game_menu(game, len(db.get_players(gid)), True) + "\n\n⚙️ <b>Управление игрой</b>"
        if not open_:
            text += "\nЖеребьёвка проведена: участников и правила менять нельзя."
        await show(ev, text, kb.manage(gid, open_))

    async def screen_players(ev: CallbackQuery, uid: int, gid: int) -> None:
        game = svc.game_for_organizer(gid, uid)
        plist = db.get_players(gid)
        lines = [
            f"{i}. {texts.player_name(p)}" + (" 👑" if p["user_id"] == game["organizer_id"] else "")
            for i, p in enumerate(plist, 1)
        ]
        open_ = game["status"] == "open"
        text = f"👥 <b>Участники</b> ({len(plist)})\n\n" + "\n".join(lines)
        if open_:
            text += "\n\nМожно убрать участника до жеребьёвки."
        await show(ev, text, kb.players(gid, plist, game["organizer_id"], open_))

    async def screen_rules(ev: CallbackQuery, uid: int, gid: int) -> None:
        game = svc.game_for_organizer(gid, uid)
        names = {p["user_id"]: p["name"] for p in db.get_players(gid)}
        rules = db.get_rules(gid)
        text = (
            "🚫 <b>Правила «кто кому не дарит»</b>\n"
            "Правило — группа от 2 человек (например, живут вместе): внутри группы "
            "никто никому не достаётся.\n\n"
        )
        if rules:
            text += "\n".join(
                f"{i}. " + ", ".join(texts.e(names.get(m, "?")) for m in members)
                for i, (_, members) in enumerate(rules, 1)
            )
        else:
            text += "<i>Правил пока нет.</i>"
        await show(ev, text, kb.rules(gid, [rid for rid, _ in rules], game["status"] == "open"))

    async def screen_my_target(ev: CallbackQuery, uid: int, gid: int) -> None:
        game = svc.game_for_player(gid, uid)
        target = db.get_receiver(gid, uid)
        if game["status"] != "drawn" or target is None:
            raise UserError("Жеребьёвка ещё не проведена.")
        player = db.get_player(gid, target)
        text = texts.assignment(game["title"], player["name"], db.get_wishes(gid, target))
        await show(ev, text, kb.back(gid))

    # ------------------------------------------------- действия (callbacks)
    async def notify_santa(bot: Bot, gid: int, uid: int) -> None:
        """Если жеребьёвка была, анонимно сообщаем Санте об изменении списка."""
        santa = svc.santa_of(gid, uid)
        if santa is None:
            return
        player = db.get_player(gid, uid)
        await safe_send(bot, santa, texts.wishes_updated(player["name"], db.get_wishes(gid, uid)))

    async def do_menu(cb: CallbackQuery, st: FSMContext, bot: Bot) -> None:
        await screen_games(cb, cb.from_user.id, force_list=True)

    async def do_new(cb: CallbackQuery, st: FSMContext, bot: Bot) -> None:
        await st.set_state(Form.title)
        await show(cb, texts.ASK_TITLE)

    async def do_game(cb, st, bot, gid):
        await screen_game(cb, cb.from_user.id, gid)

    async def do_wishlist(cb, st, bot, gid):
        await screen_wishlist(cb, cb.from_user.id, gid)

    async def do_wish_add(cb, st, bot, gid):
        svc.game_for_player(gid, cb.from_user.id)
        await st.set_state(Form.wish_add)
        await st.update_data(gid=gid)
        await show(cb, texts.ASK_WISH, kb.cancel_input(gid))

    async def do_wish_item(cb, st, bot, gid, wid):
        svc.game_for_player(gid, cb.from_user.id)
        wish = db.get_wish(wid)
        if wish is None or wish["game_id"] != gid or wish["user_id"] != cb.from_user.id:
            raise UserError("Такого пункта уже нет.")
        await show(cb, f"🎁 {texts.e(wish['text'])}", kb.wish_item(gid, wid))

    async def do_wish_edit(cb, st, bot, gid, wid):
        svc.game_for_player(gid, cb.from_user.id)
        wish = db.get_wish(wid)
        if wish is None or wish["game_id"] != gid or wish["user_id"] != cb.from_user.id:
            raise UserError("Такого пункта уже нет.")
        await st.set_state(Form.wish_edit)
        await st.update_data(gid=gid, wid=wid)
        await show(cb, f"Сейчас: {texts.e(wish['text'])}\n\nОтправьте новый текст.", kb.cancel_input(gid))

    async def do_wish_del(cb, st, bot, gid, wid):
        svc.delete_wish(gid, cb.from_user.id, wid)
        await screen_wishlist(cb, cb.from_user.id, gid)
        await notify_santa(bot, gid, cb.from_user.id)

    async def do_target(cb, st, bot, gid):
        await screen_my_target(cb, cb.from_user.id, gid)

    async def do_leave(cb, st, bot, gid):
        svc.game_for_player(gid, cb.from_user.id)
        await show(cb, "Выйти из игры? Ваш список подарков будет удалён.",
                   kb.confirm(f"lvy:{gid}", f"g:{gid}", "🚪 Да, выйти", "⬅️ Остаться"))

    async def do_leave_yes(cb, st, bot, gid):
        game = svc.game_for_player(gid, cb.from_user.id)
        svc.leave(gid, cb.from_user.id)
        await safe_send(bot, game["organizer_id"],
                        f"👋 Участник {texts.e(_name(cb.from_user))} вышел из игры «{texts.e(game['title'])}».")
        await screen_games(cb, cb.from_user.id)

    async def do_manage(cb, st, bot, gid):
        await screen_manage(cb, cb.from_user.id, gid)

    async def do_link(cb, st, bot, gid):
        game = svc.game_for_organizer(gid, cb.from_user.id)
        me = await bot.me()
        await show(cb, texts.invite(f"https://t.me/{me.username}?start={game['code']}"), kb.back_manage(gid))

    async def do_players(cb, st, bot, gid):
        await screen_players(cb, cb.from_user.id, gid)

    async def do_player_remove(cb, st, bot, gid, target):
        svc.organizer_open_game(gid, cb.from_user.id)
        player = db.get_player(gid, target)
        if player is None or target == cb.from_user.id:
            raise UserError("Этого участника нельзя убрать.")
        await show(cb, f"Убрать {texts.player_name(player)} из игры? Его список подарков удалится.",
                   kb.confirm(f"mpy:{gid}:{target}", f"mp:{gid}", "❌ Убрать", "⬅️ Отмена"))

    async def do_player_remove_yes(cb, st, bot, gid, target):
        game = svc.game_for_organizer(gid, cb.from_user.id)
        svc.remove_player(gid, cb.from_user.id, target)
        await safe_send(bot, target, f"Организатор убрал вас из игры «{texts.e(game['title'])}».")
        await screen_players(cb, cb.from_user.id, gid)

    async def do_rules(cb, st, bot, gid):
        await screen_rules(cb, cb.from_user.id, gid)

    async def do_rule_add(cb, st, bot, gid):
        svc.organizer_open_game(gid, cb.from_user.id)
        await st.set_state(Form.rule)
        await st.update_data(gid=gid, sel=[])
        await show_picker(cb, gid, set())

    async def show_picker(cb: CallbackQuery, gid: int, selected: set[int]) -> None:
        await show(cb, "Отметьте людей, которые не должны дарить друг другу (минимум 2):",
                   kb.rule_picker(gid, db.get_players(gid), selected))

    async def do_rule_toggle(cb, st, bot, gid, uid):
        svc.organizer_open_game(gid, cb.from_user.id)
        data = await st.get_data()
        sel = set(data.get("sel", [])) if data.get("gid") == gid else set()
        sel ^= {uid}
        await st.set_state(Form.rule)
        await st.update_data(gid=gid, sel=sorted(sel))
        await show_picker(cb, gid, sel)

    async def do_rule_save(cb, st, bot, gid):
        data = await st.get_data()
        sel = set(data.get("sel", [])) if data.get("gid") == gid else set()
        svc.create_rule(gid, cb.from_user.id, sel)
        await st.clear()
        await screen_rules(cb, cb.from_user.id, gid)

    async def do_rule_del(cb, st, bot, gid, rid):
        svc.delete_rule(gid, cb.from_user.id, rid)
        await screen_rules(cb, cb.from_user.id, gid)

    async def do_draw(cb, st, bot, gid):
        game = svc.organizer_open_game(gid, cb.from_user.id)
        n = len(db.get_players(gid))
        if n < config.MIN_PLAYERS:
            raise UserError(f"Для жеребьёвки нужно минимум {config.MIN_PLAYERS} участника, сейчас {n}.")
        await show(cb, f"Запустить жеребьёвку в «{texts.e(game['title'])}»? Участников: {n}.\n\n"
                       "После этого новые участники вступить не смогут, а правила менять нельзя.",
                   kb.confirm(f"mdy:{gid}", f"m:{gid}", "🎲 Запустить", "⬅️ Отмена"))

    async def do_draw_yes(cb, st, bot, gid):
        game = svc.game_for_organizer(gid, cb.from_user.id)
        try:
            assignment = svc.run_draw(gid, cb.from_user.id)
        except DrawImpossible:
            await show(cb, texts.draw_impossible(game["title"]), kb.draw_retry(gid))
            return
        failed: list[str] = []
        for giver, receiver in assignment.items():
            rp = db.get_player(gid, receiver)
            text = texts.assignment(game["title"], rp["name"], db.get_wishes(gid, receiver))
            if not await safe_send(bot, giver, text, kb.back(gid)):
                failed.append(texts.e(db.get_player(gid, giver)["name"]))
        text = "🎉 Жеребьёвка проведена! Каждый участник получил личное сообщение со своей парой."
        if failed:
            text += ("\n\n⚠️ Не удалось доставить: " + ", ".join(failed) +
                     ". Пусть нажмут «🎯 Кому я дарю» в меню игры.")
        text += "\n\nВаша пара пришла вам отдельным сообщением; чужих пар вы не видите."
        await show(cb, text, kb.back_manage(gid))

    # (обработчик, число int-аргументов, очищать ли состояние FSM)
    routes: dict[str, tuple[Callable[..., Awaitable[None]], int, bool]] = {
        "menu": (do_menu, 0, True), "new": (do_new, 0, True),
        "g": (do_game, 1, True), "w": (do_wishlist, 1, True), "wa": (do_wish_add, 1, True),
        "wi": (do_wish_item, 2, True), "we": (do_wish_edit, 2, True), "wd": (do_wish_del, 2, True),
        "to": (do_target, 1, True), "lv": (do_leave, 1, True), "lvy": (do_leave_yes, 1, True),
        "m": (do_manage, 1, True), "ml": (do_link, 1, True), "mp": (do_players, 1, True),
        "mpr": (do_player_remove, 2, True), "mpy": (do_player_remove_yes, 2, True),
        "mr": (do_rules, 1, True), "mra": (do_rule_add, 1, True), "mrt": (do_rule_toggle, 2, False),
        "mrs": (do_rule_save, 1, False), "mrd": (do_rule_del, 2, True),
        "md": (do_draw, 1, True), "mdy": (do_draw_yes, 1, True),
    }

    @router.callback_query()
    async def on_callback(cb: CallbackQuery, state: FSMContext, bot: Bot) -> None:
        action, *raw = (cb.data or "").split(":")
        route = routes.get(action)
        try:
            if route is None or len(raw) != route[1]:
                raise UserError("Эта кнопка устарела. Откройте меню: /start")
            handler, _, clear = route
            if clear:
                await state.clear()
            await handler(cb, state, bot, *(int(x) for x in raw))
        except (UserError, ValueError) as exc:
            msg = str(exc) if isinstance(exc, UserError) else "Эта кнопка устарела. Откройте меню: /start"
            await cb.answer(msg, show_alert=True)
            return
        await cb.answer()

    # ----------------------------------------------------------- команды
    @router.message(Command("start"))
    async def on_start(msg: Message, command: CommandObject, state: FSMContext, bot: Bot) -> None:
        await state.clear()
        uid = msg.from_user.id
        name = _name(msg.from_user)
        db.update_player_name(uid, name)
        code = (command.args or "").strip()
        if not code:
            return await screen_games(msg, uid)
        result, game = svc.join(code, uid, name)
        if result is JoinResult.NOT_FOUND:
            await msg.answer("Игра по этой ссылке не найдена. Попросите организатора прислать ссылку заново.")
            return await screen_games(msg, uid)
        title = texts.e(game["title"])
        if result is JoinResult.CLOSED:
            await msg.answer(f"В игре «{title}» жеребьёвка уже проведена — вступить нельзя.")
            return await screen_games(msg, uid)
        if result is JoinResult.FULL:
            await msg.answer(f"В игре «{title}» уже максимум участников ({config.MAX_PLAYERS}).")
            return await screen_games(msg, uid)
        if result is JoinResult.JOINED:
            await msg.answer(f"Вы в игре «{title}»! 🎉 Добавьте в список подарки, которые хотели бы получить.")
            count = len(db.get_players(game["id"]))
            await safe_send(bot, game["organizer_id"],
                            f"👤 Новый участник игры «{title}»: {texts.e(name)}. Всего: {count}.")
        await screen_game(msg, uid, game["id"])

    @router.message(Command("menu"))
    async def on_menu(msg: Message, state: FSMContext) -> None:
        await state.clear()
        await screen_games(msg, msg.from_user.id)

    @router.message(Command("new"))
    async def on_new(msg: Message, state: FSMContext) -> None:
        await state.set_state(Form.title)
        await msg.answer(texts.ASK_TITLE)

    @router.message(Command("cancel"))
    async def on_cancel(msg: Message, state: FSMContext) -> None:
        await state.clear()
        await msg.answer(texts.CANCELLED)
        await screen_games(msg, msg.from_user.id)

    # --------------------------------------------------- ввод текста (FSM)
    TEXT = F.text & ~F.text.startswith("/")

    @router.message(Form.title, TEXT)
    async def on_title(msg: Message, state: FSMContext, bot: Bot) -> None:
        try:
            game = svc.create_game(msg.text, msg.from_user.id, _name(msg.from_user))
        except UserError as exc:
            return await msg.answer(str(exc))
        await state.clear()
        me = await bot.me()
        await msg.answer(
            f"Игра «{texts.e(game['title'])}» создана! 🎄\n\n"
            f"Ссылка-приглашение:\n{texts.e(f'https://t.me/{me.username}?start={game['code']}')}\n\n"
            "Разошлите её участникам. Когда все вступят — запустите жеребьёвку в «Управление игрой»."
        )
        await screen_game(msg, msg.from_user.id, game["id"])

    @router.message(Form.wish_add, TEXT)
    async def on_wish_add(msg: Message, state: FSMContext, bot: Bot) -> None:
        gid = (await state.get_data())["gid"]
        try:
            svc.add_wish(gid, msg.from_user.id, msg.text)
        except UserError as exc:
            return await msg.answer(str(exc), reply_markup=kb.cancel_input(gid))
        await state.clear()
        await msg.answer("Добавлено ✅\n\n" + texts.my_wishlist(db.get_wishes(gid, msg.from_user.id),
                         db.get_game(gid)["status"] == "drawn"), reply_markup=kb.after_wish(gid))
        await notify_santa(bot, gid, msg.from_user.id)

    @router.message(Form.wish_edit, TEXT)
    async def on_wish_edit(msg: Message, state: FSMContext, bot: Bot) -> None:
        data = await state.get_data()
        gid, wid = data["gid"], data["wid"]
        try:
            svc.edit_wish(gid, msg.from_user.id, wid, msg.text)
        except UserError as exc:
            return await msg.answer(str(exc), reply_markup=kb.cancel_input(gid))
        await state.clear()
        await msg.answer("Изменено ✅\n\n" + texts.my_wishlist(db.get_wishes(gid, msg.from_user.id),
                         db.get_game(gid)["status"] == "drawn"), reply_markup=kb.after_wish(gid))
        await notify_santa(bot, gid, msg.from_user.id)

    @router.message(StateFilter(Form.title, Form.wish_add, Form.wish_edit), ~F.text)
    async def on_non_text(msg: Message) -> None:
        await msg.answer("Пришлите, пожалуйста, обычное текстовое сообщение.")

    @router.message()
    async def on_other(msg: Message) -> None:
        await msg.answer(texts.UNKNOWN_TEXT)

    return router
