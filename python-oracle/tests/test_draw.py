import random

import pytest

from santa_bot.draw import DrawImpossible, count_mutual, forbidden_pairs, make_draw


def check_valid(assignment, players, rules):
    assert set(assignment) == set(players)
    assert sorted(assignment.values()) == sorted(players)  # перестановка
    bad = forbidden_pairs(rules)
    for g, r in assignment.items():
        assert g != r
        assert (g, r) not in bad


@pytest.mark.parametrize("seed", range(50))
def test_basic_no_self_no_mutual(seed):
    players = list(range(1, 8))
    a = make_draw(players, [], random.Random(seed))
    check_valid(a, players, [])
    assert count_mutual(a) == 0


def test_three_players_is_a_cycle():
    for seed in range(20):
        a = make_draw([1, 2, 3], [], random.Random(seed))
        check_valid(a, [1, 2, 3], [])
        assert count_mutual(a) == 0


@pytest.mark.parametrize("seed", range(30))
def test_rules_respected(seed):
    players = list(range(1, 9))
    rules = [[1, 2], [3, 4, 5], [6, 7]]
    a = make_draw(players, rules, random.Random(seed))
    check_valid(a, players, rules)


def test_overlapping_rules():
    players = list(range(1, 7))
    rules = [[1, 2, 3], [3, 4], [4, 5, 6]]
    for seed in range(20):
        check_valid(make_draw(players, rules, random.Random(seed)), players, rules)


def test_impossible_group_too_big():
    # 4 из 6 в одной группе: им некому дарить внутри, а вне — только 2 человека.
    with pytest.raises(DrawImpossible):
        make_draw(list(range(1, 7)), [[1, 2, 3, 4]], random.Random(0))


def test_impossible_everyone_in_one_group():
    with pytest.raises(DrawImpossible):
        make_draw([1, 2, 3], [[1, 2, 3]], random.Random(0))


def test_impossible_two_players():
    with pytest.raises(DrawImpossible):
        make_draw([1], [])


def test_impossible_when_three_share_one_recipient():
    # 1, 2, 3 не могут дарить друг другу, значит все трое должны дарить только 4 — невозможно.
    with pytest.raises(DrawImpossible):
        make_draw([1, 2, 3, 4], [[1, 2], [1, 3], [2, 3]], random.Random(0))


def test_mutual_avoided_when_possible():
    # Две пары-«семьи»: можно раздать по кругу 1->3->2->4->1 без взаимных пар.
    rules = [[1, 2], [3, 4]]
    for seed in range(20):
        a = make_draw([1, 2, 3, 4], rules, random.Random(seed))
        check_valid(a, [1, 2, 3, 4], rules)
        assert count_mutual(a) == 0


def test_unavoidable_mutual_pair_is_allowed():
    # 1 и 2 могут дарить только друг другу (3 и 4 им запрещены) — взаимная пара вынужденная.
    rules = [[1, 3], [1, 4], [2, 3], [2, 4]]
    for seed in range(20):
        a = make_draw([1, 2, 3, 4], rules, random.Random(seed))
        check_valid(a, [1, 2, 3, 4], rules)
        assert a[1] == 2 and a[2] == 1


def test_minimizes_mutual_pairs():
    # Взаимная пара 1<->2 вынужденная, но у 3..6 она не должна появляться.
    players = [1, 2, 3, 4, 5, 6]
    rules = [[1, 3], [1, 4], [1, 5], [1, 6], [2, 3], [2, 4], [2, 5], [2, 6]]
    for seed in range(20):
        a = make_draw(players, rules, random.Random(seed))
        check_valid(a, players, rules)
        assert count_mutual(a) == 1


def test_large_game_fast():
    players = list(range(1, 51))
    rules = [[i, i + 1] for i in range(1, 50, 2)]
    a = make_draw(players, rules, random.Random(1))
    check_valid(a, players, rules)
    assert count_mutual(a) == 0


def test_distribution_is_not_constant():
    players = list(range(1, 6))
    seen = {tuple(sorted(make_draw(players, [], random.Random(s)).items())) for s in range(40)}
    assert len(seen) > 5
