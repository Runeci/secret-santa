import pytest

from santa_bot import config
from santa_bot.db import Database
from santa_bot.draw import DrawImpossible
from santa_bot.service import JoinResult, Service, UserError

ORG = 1


@pytest.fixture
def svc():
    return Service(Database(":memory:"))


@pytest.fixture
def game(svc):
    return svc.create_game("Новый год", ORG, "Орг")


def join(svc, game, *uids):
    for u in uids:
        assert svc.join(game["code"], u, f"U{u}")[0] is JoinResult.JOINED


def test_create_and_join(svc, game):
    assert svc.db.is_player(game["id"], ORG)
    join(svc, game, 2)
    assert svc.join(game["code"], 2, "U2")[0] is JoinResult.ALREADY
    assert svc.join("nope", 3, "x")[0] is JoinResult.NOT_FOUND


def test_title_validation(svc):
    with pytest.raises(UserError):
        svc.create_game("   ", ORG, "x")
    with pytest.raises(UserError):
        svc.create_game("a" * (config.MAX_TITLE_LEN + 1), ORG, "x")


def test_wish_limits(svc, game):
    gid = game["id"]
    for i in range(config.MAX_WISHES):
        svc.add_wish(gid, ORG, f"подарок {i}")
    with pytest.raises(UserError):
        svc.add_wish(gid, ORG, "ещё")
    wid = svc.db.get_wishes(gid, ORG)[0]["id"]
    svc.delete_wish(gid, ORG, wid)
    svc.add_wish(gid, ORG, "x" * config.MAX_WISH_LEN)  # ровно по лимиту — можно
    svc.delete_wish(gid, ORG, svc.db.get_wishes(gid, ORG)[0]["id"])
    with pytest.raises(UserError):
        svc.add_wish(gid, ORG, "x" * (config.MAX_WISH_LEN + 1))
    with pytest.raises(UserError):
        svc.add_wish(gid, ORG, "  ")


def test_cannot_touch_foreign_wish(svc, game):
    gid = game["id"]
    join(svc, game, 2)
    wid = svc.add_wish(gid, 2, "книга")
    with pytest.raises(UserError):
        svc.edit_wish(gid, ORG, wid, "взлом")
    with pytest.raises(UserError):
        svc.delete_wish(gid, ORG, wid)
    svc.edit_wish(gid, 2, wid, "две книги")
    assert svc.db.get_wish(wid)["text"] == "две книги"


def test_non_member_cannot_add_wish(svc, game):
    with pytest.raises(UserError):
        svc.add_wish(game["id"], 99, "x")


def test_rules_only_organizer(svc, game):
    gid = game["id"]
    join(svc, game, 2, 3)
    with pytest.raises(UserError):
        svc.create_rule(gid, 2, {2, 3})
    with pytest.raises(UserError):
        svc.create_rule(gid, ORG, {2})  # минимум 2
    with pytest.raises(UserError):
        svc.create_rule(gid, ORG, {2, 777})  # чужак
    rid = svc.create_rule(gid, ORG, {2, 3})
    with pytest.raises(UserError):
        svc.create_rule(gid, ORG, {2, 3})  # дубликат
    with pytest.raises(UserError):
        svc.delete_rule(gid, 2, rid)
    svc.delete_rule(gid, ORG, rid)
    assert svc.db.get_rules(gid) == []


def test_remove_player_cleans_rules_and_wishes(svc, game):
    gid = game["id"]
    join(svc, game, 2, 3, 4)
    svc.add_wish(gid, 3, "x")
    svc.create_rule(gid, ORG, {2, 3})
    svc.create_rule(gid, ORG, {2, 3, 4})
    with pytest.raises(UserError):
        svc.remove_player(gid, 2, 3)  # не организатор
    with pytest.raises(UserError):
        svc.remove_player(gid, ORG, ORG)
    svc.remove_player(gid, ORG, 3)
    assert not svc.db.is_player(gid, 3)
    assert svc.db.get_wishes(gid, 3) == []
    rules = [sorted(m) for _, m in svc.db.get_rules(gid)]
    assert rules == [[2, 4]]  # правило из двух стало 1 человеком и исчезло


def test_draw_needs_three(svc, game):
    join(svc, game, 2)
    with pytest.raises(UserError):
        svc.run_draw(game["id"], ORG)


def test_draw_only_organizer_and_once(svc, game):
    gid = game["id"]
    join(svc, game, 2, 3)
    with pytest.raises(UserError):
        svc.run_draw(gid, 2)
    a = svc.run_draw(gid, ORG)
    assert svc.db.get_assignments(gid) == a
    with pytest.raises(UserError):
        svc.run_draw(gid, ORG)


def test_draw_impossible_leaves_game_open(svc, game):
    gid = game["id"]
    join(svc, game, 2, 3)
    svc.create_rule(gid, ORG, {1, 2, 3})
    with pytest.raises(DrawImpossible):
        svc.run_draw(gid, ORG)
    assert svc.db.get_game(gid)["status"] == "open"
    # организатор удаляет правило — и всё получается
    svc.delete_rule(gid, ORG, svc.db.get_rules(gid)[0][0])
    svc.run_draw(gid, ORG)


def test_locked_after_draw(svc, game):
    gid = game["id"]
    join(svc, game, 2, 3)
    svc.run_draw(gid, ORG)
    assert svc.join(game["code"], 9, "late")[0] is JoinResult.CLOSED
    with pytest.raises(UserError):
        svc.create_rule(gid, ORG, {2, 3})
    with pytest.raises(UserError):
        svc.remove_player(gid, ORG, 2)
    with pytest.raises(UserError):
        svc.leave(gid, 2)
    # а подарки редактировать можно
    wid = svc.add_wish(gid, 2, "носки")
    svc.edit_wish(gid, 2, wid, "тёплые носки")
    svc.delete_wish(gid, 2, wid)


def test_max_players(svc, game, monkeypatch):
    monkeypatch.setattr(config, "MAX_PLAYERS", 2)
    join(svc, game, 2)
    assert svc.join(game["code"], 3, "x")[0] is JoinResult.FULL


def test_santa_lookup(svc, game):
    gid = game["id"]
    join(svc, game, 2, 3)
    assert svc.santa_of(gid, 2) is None
    a = svc.run_draw(gid, ORG)
    for giver, receiver in a.items():
        assert svc.santa_of(gid, receiver) == giver
