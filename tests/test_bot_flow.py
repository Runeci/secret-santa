"""Сквозные тесты: настоящий Dispatcher + фейковая сессия вместо Telegram."""
import html
import re
from datetime import datetime

import pytest
from aiogram import Bot
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.base import BaseSession
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramForbiddenError
from aiogram.methods import (AnswerCallbackQuery, EditMessageText, GetMe,
                             SendMessage)
from aiogram.types import Chat, Message, Update, User

from santa_bot.db import Database
from santa_bot.main import build_dispatcher

BOT_USERNAME = "santa_test_bot"


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.sent: list[dict] = []       # исходящие сообщения/правки
        self.alerts: list[str] = []      # всплывающие alert-ы
        self.blocked: set[int] = set()   # пользователи, заблокировавшие бота
        self._mid = 0

    async def close(self): ...

    async def stream_content(self, *a, **kw):  # pragma: no cover
        yield b""

    async def make_request(self, bot, method, timeout=None):
        if isinstance(method, GetMe):
            return User(id=1, is_bot=True, first_name="Santa", username=BOT_USERNAME)
        if isinstance(method, AnswerCallbackQuery):
            if method.show_alert and method.text:
                self.alerts.append(method.text)
            return True
        if isinstance(method, (SendMessage, EditMessageText)):
            chat_id = int(method.chat_id)
            if isinstance(method, SendMessage) and chat_id in self.blocked:
                raise TelegramForbiddenError(method=method, message="Forbidden: bot was blocked")
            self._mid += 1
            self.sent.append({
                "chat": chat_id, "text": method.text, "markup": method.reply_markup,
                "edit": isinstance(method, EditMessageText),
            })
            return Message(message_id=self._mid, date=datetime.now(),
                           chat=Chat(id=chat_id, type="private"), text=method.text)
        raise NotImplementedError(method)


def plain(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text))


class Client:
    def __init__(self, env, uid, name):
        self.env, self.uid, self.name = env, uid, name
        self._upd = uid * 1000

    def _next(self):
        self._upd += 1
        return self._upd

    def _user(self):
        return {"id": self.uid, "is_bot": False, "first_name": self.name, "username": f"user{self.uid}"}

    async def _feed(self, payload):
        upd = Update.model_validate({"update_id": self.env.next_id(), **payload}, context={"bot": self.env.bot})
        await self.env.dp.feed_update(self.env.bot, upd)

    async def say(self, text):
        await self._feed({"message": {
            "message_id": self._next(), "date": int(datetime.now().timestamp()),
            "chat": {"id": self.uid, "type": "private"}, "from": self._user(), "text": text,
            "entities": [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}]
            if text.startswith("/") else None}})

    def last_markup(self):
        for item in reversed(self.env.session.sent):
            if item["chat"] == self.uid and item["markup"] is not None:
                return item["markup"]
        raise AssertionError("нет клавиатуры")

    def buttons(self):
        return [b for row in self.last_markup().inline_keyboard for b in row]

    async def click(self, label):
        matches = [b for b in self.buttons() if label in b.text]
        assert matches, f"нет кнопки {label!r}; есть: {[b.text for b in self.buttons()]}"
        await self._feed({"callback_query": {
            "id": str(self._next()), "from": self._user(), "chat_instance": "x",
            "data": matches[0].callback_data,
            "message": {"message_id": 1, "date": int(datetime.now().timestamp()),
                        "chat": {"id": self.uid, "type": "private"}}}})

    def inbox(self):
        return [plain(i["text"]) for i in self.env.session.sent if i["chat"] == self.uid]

    def last(self):
        return self.inbox()[-1]

    def has_button(self, label):
        return any(label in b.text for b in self.buttons())


class Env:
    def __init__(self):
        self.session = FakeSession()
        self.bot = Bot("123456:TEST", session=self.session,
                       default=DefaultBotProperties(parse_mode=ParseMode.HTML))
        self.db = Database(":memory:")
        self.dp = build_dispatcher(self.db)
        self._id = 0

    def next_id(self):
        self._id += 1
        return self._id

    def user(self, uid, name):
        return Client(self, uid, name)


@pytest.fixture
def env():
    return Env()


async def create_game(env, org, title="Офис 2026"):
    await org.say("/new")
    assert "назовём" in org.last()
    await org.say(title)
    link = re.search(r"start=(\S+)", org.inbox()[-2]).group(1)
    return link


async def test_full_flow(env):
    org, ann, bob, cat = (env.user(1, "Организатор"), env.user(2, "Аня"),
                          env.user(3, "Боб"), env.user(4, "Катя"))
    code = await create_game(env, org)
    assert f"t.me/{BOT_USERNAME}?start={code}" in org.inbox()[-2]
    gid = env.db.get_game_by_code(code)["id"]

    # регистрация + уведомление организатору
    for u in (ann, bob, cat):
        await u.say(f"/start {code}")
        assert "Вы в игре" in u.inbox()[-2]
    assert any("Новый участник" in m and "Аня" in m for m in org.inbox())
    assert len(env.db.get_players(gid)) == 4

    # список подарков: добавить, изменить, удалить
    await ann.click("Добавить подарок")
    await ann.say("Книга <Дюна>")
    assert "Добавлено" in ann.last() and "Книга <Дюна>" in ann.last()
    await ann.click("Добавить ещё")
    await ann.say("Носки")
    await ann.click("Мой список")
    await ann.click("Носки")
    await ann.click("Изменить")
    await ann.say("Тёплые носки")
    assert "Тёплые носки" in ann.last()
    await bob.click("Добавить подарок")
    await bob.say("Кофе")
    await cat.click("Добавить подарок")
    await cat.say("Плед")

    # лимиты
    await bob.click("Добавить ещё")
    await bob.say("x" * 301)
    assert "Слишком длинно" in bob.last()
    await bob.say("Чай")  # состояние сохранилось, второй попыткой принимается
    assert "Добавлено" in bob.last()

    # участник не видит управления
    await ann.click("В меню игры")
    assert not ann.has_button("Управление")
    assert not ann.has_button("Кому я дарю")  # до жеребьёвки

    # правило: Аня и Боб живут вместе
    await org.click("Управление")
    await org.click("Правила")
    await org.click("Добавить правило")
    await org.click("Аня")
    await org.click("Сохранить")
    assert "минимум 2" in env.session.alerts[-1]
    await org.click("Боб")
    await org.click("Сохранить")
    assert "Аня" in org.last() and "Боб" in org.last()
    assert env.db.get_rules(gid)[0][1] == [2, 3]

    # удаление участника до жеребьёвки
    await org.click("Управление")
    await org.click("Участники")
    assert not any("Организатор" in b.text and "Убрать" in b.text for b in org.buttons())
    await org.click("Убрать: Катя")
    await org.click("Убрать")
    assert not env.db.is_player(gid, 4)
    assert any("убрал вас" in m for m in cat.inbox())

    # остались трое, но правило «Аня+Боб» делает жеребьёвку невозможной
    await org.click("Управление")
    await org.click("Провести жеребьёвку")
    await org.click("Запустить")
    assert "невозможна" in org.last()
    assert env.db.get_game(gid)["status"] == "open"

    # Катя возвращается по ссылке, снова 4 участника
    await cat.say(f"/start {code}")
    await cat.click("Добавить подарок")
    await cat.say("Плед")

    # жеребьёвка
    before = len(env.session.sent)
    await org.click("Управление")
    await org.click("Провести жеребьёвку")
    await org.click("Запустить")
    assert "Жеребьёвка проведена" in org.last()
    for u in (org, ann, bob, cat):
        assert any("Тайный Санта для" in m for m in u.inbox()), u.name
    a = env.db.get_assignments(gid)
    assert a[2] != 3 and a[3] != 2  # правило
    assert all(g != r for g, r in a.items())

    # DM содержит имя и список получателя
    names = {1: "Организатор", 2: "Аня", 3: "Боб", 4: "Катя"}
    users = {1: org, 2: ann, 3: bob, 4: cat}
    for giver, receiver in a.items():
        dm = next(m for m in users[giver].inbox() if "Тайный Санта для" in m)
        assert names[receiver] in dm
    # организатор видит только свою пару: в его чате нет чужих «Санта для»
    org_dms = [m for m in org.inbox() if "Тайный Санта для" in m]
    assert len(org_dms) == 1 and names[a[1]] in org_dms[0]

    # кнопка «Кому я дарю»
    await ann.say("/start")
    await ann.click("Кому я дарю")
    assert names[a[2]] in ann.last()

    # после жеребьёвки: нельзя вступить, нельзя менять правила и убирать участников
    late = env.user(9, "Опоздавший")
    await late.say(f"/start {code}")
    assert "вступить нельзя" in late.inbox()[-2]
    assert not env.db.is_player(gid, 9)
    await org.say("/start")
    await org.click("Управление")
    assert not org.has_button("жеребьёвку")
    await org.click("Правила")
    assert not org.has_button("Добавить правило") and not org.has_button("Удалить")
    await org.click("Управление")
    await org.click("Участники")
    assert not org.has_button("Убрать")

    # изменение списка после жеребьёвки -> анонимное сообщение Санте
    santa_of_ann = users[env.db.get_giver(gid, 2)]
    n_before = len(santa_of_ann.inbox())
    await ann.say("/start")
    await ann.click("Добавить подарок")
    await ann.say("Шоколад")
    notes = [m for m in santa_of_ann.inbox()[n_before:] if "обновил" in m]
    assert len(notes) == 1 and "Шоколад" in notes[0] and "Тёплые носки" in notes[0]
    # получатель не узнаёт Санту: ему самому уведомлений об этом не приходит
    assert not any("обновил" in m for m in ann.inbox())

    # удаление подарка тоже уведомляет
    n_before = len(santa_of_ann.inbox())
    await ann.click("Мой список")
    await ann.click("Шоколад")
    await ann.click("Удалить")
    assert any("обновил" in m and "Шоколад" not in m for m in santa_of_ann.inbox()[n_before:])

    # кто не имеет Санты-получателя, не создаёт лишних уведомлений: Боб правит список — уведомление его Санте
    santa_of_bob = users[env.db.get_giver(gid, 3)]
    n_before = len(santa_of_bob.inbox())
    await bob.say("/start")
    await bob.click("Мой список")
    await bob.click("Чай")
    await bob.click("Изменить")
    await bob.say("Зелёный чай")
    assert any("Зелёный чай" in m for m in santa_of_bob.inbox()[n_before:])


async def test_draw_impossible_then_remove_rule(env):
    org, a, b = env.user(1, "Орг"), env.user(2, "А"), env.user(3, "Б")
    code = await create_game(env, org)
    for u in (a, b):
        await u.say(f"/start {code}")
    gid = env.db.get_game_by_code(code)["id"]
    await org.click("Управление")
    await org.click("Правила")
    await org.click("Добавить правило")
    for n in ("Орг", "А", "Б"):
        await org.click(n)
    await org.click("Сохранить")
    await org.click("Управление")
    await org.click("Провести жеребьёвку")
    await org.click("Запустить")
    assert "невозможна" in org.last()
    assert env.db.get_game(gid)["status"] == "open"
    assert org.has_button("Открыть правила")
    await org.click("Открыть правила")
    await org.click("Удалить правило 1")
    await org.click("Управление")
    await org.click("Провести жеребьёвку")
    await org.click("Запустить")
    assert "Жеребьёвка проведена" in org.last()
    assert env.db.get_game(gid)["status"] == "drawn"


async def test_participant_cannot_use_organizer_buttons(env):
    org, a = env.user(1, "Орг"), env.user(2, "А")
    code = await create_game(env, org)
    await a.say(f"/start {code}")
    gid = env.db.get_game_by_code(code)["id"]
    # подделанные callback-и участника
    for data in (f"mdy:{gid}", f"mra:{gid}", f"mpy:{gid}:1", f"m:{gid}", f"ml:{gid}"):
        env.session.alerts.clear()
        await a._feed({"callback_query": {
            "id": "1", "from": a._user(), "chat_instance": "x", "data": data,
            "message": {"message_id": 1, "date": 0, "chat": {"id": 2, "type": "private"}}}})
        assert env.session.alerts and "организатор" in env.session.alerts[-1].lower(), data
    assert env.db.get_game(gid)["status"] == "open"
    assert env.db.is_player(gid, 1)


async def test_multiple_games_and_leave(env):
    org, a = env.user(1, "Орг"), env.user(2, "А")
    c1 = await create_game(env, org, "Игра один")
    c2 = await create_game(env, org, "Игра два")
    await a.say(f"/start {c1}")
    await a.say(f"/start {c2}")
    await a.say("/start")
    assert "Ваши игры" in a.last()
    assert a.has_button("Игра один") and a.has_button("Игра два")
    await a.click("Игра один")
    await a.click("Выйти из игры")
    await a.click("Да, выйти")
    gid1 = env.db.get_game_by_code(c1)["id"]
    assert not env.db.is_player(gid1, 2)
    assert any("вышел" in m for m in org.inbox())


async def test_blocked_user_reported_not_leaked(env):
    org, a, b = env.user(1, "Орг"), env.user(2, "А"), env.user(3, "Б")
    code = await create_game(env, org)
    for u in (a, b):
        await u.say(f"/start {code}")
    env.session.blocked.add(3)
    await org.click("Управление")
    await org.click("Провести жеребьёвку")
    await org.click("Запустить")
    assert "Не удалось доставить" in org.last() and "Б" in org.last()
    # Б всё равно может узнать пару кнопкой
    env.session.blocked.clear()
    await b.say("/start")
    await b.click("Кому я дарю")
    assert "Тайный Санта для" in b.last()


async def test_bad_link_and_stale_buttons(env):
    u = env.user(5, "Z")
    await u.say("/start doesnotexist")
    assert any("не найдена" in m for m in u.inbox())
    await u._feed({"callback_query": {
        "id": "1", "from": u._user(), "chat_instance": "x", "data": "zzz:1",
        "message": {"message_id": 1, "date": 0, "chat": {"id": 5, "type": "private"}}}})
    assert "устарела" in env.session.alerts[-1]


async def test_html_in_names_is_escaped(env):
    org = env.user(1, "Орг")
    await org.say("/new")
    await org.say("<b>Игра</b> & co")
    game = env.db.get_game_by_code(re.search(r"start=(\S+)", org.inbox()[-2]).group(1))
    assert game["title"] == "<b>Игра</b> & co"
    raw = [i["text"] for i in env.session.sent if i["chat"] == 1][-1]
    assert "&lt;b&gt;Игра&lt;/b&gt; &amp; co" in raw


async def test_draw_needs_three_players(env):
    org, a = env.user(1, "Орг"), env.user(2, "А")
    code = await create_game(env, org)
    await a.say(f"/start {code}")
    await org.click("Управление")
    await org.click("Провести жеребьёвку")
    assert "минимум 3" in env.session.alerts[-1]
