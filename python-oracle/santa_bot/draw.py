"""Жеребьёвка тайного Санты. Чистая логика, без Telegram и БД.

Ищем перестановку «даритель -> получатель» такую, что:
  * никто не дарит себе;
  * внутри группы-правила никто никому не достаётся;
  * взаимных пар (A->B и B->A) как можно меньше (по возможности ноль).
"""
import random
from collections.abc import Iterable, Sequence


class DrawImpossible(Exception):
    """С заданными ограничениями корректного распределения не существует."""


def forbidden_pairs(rules: Iterable[Iterable[int]]) -> set[tuple[int, int]]:
    pairs: set[tuple[int, int]] = set()
    for group in rules:
        members = list(group)
        for a in members:
            for b in members:
                if a != b:
                    pairs.add((a, b))
    return pairs


def _allowed(
    players: Sequence[int], forbidden: set[tuple[int, int]]
) -> dict[int, list[int]]:
    return {
        a: [b for b in players if b != a and (a, b) not in forbidden]
        for a in players
    }


def _random_matching(
    players: Sequence[int], allowed: dict[int, list[int]], rng: random.Random
) -> dict[int, int] | None:
    """Случайное совершенное паросочетание (алгоритм Куна). None, если его нет."""
    match_of: dict[int, int] = {}  # получатель -> даритель
    order = list(players)
    rng.shuffle(order)

    def try_assign(giver: int, seen: set[int]) -> bool:
        options = allowed[giver][:]
        rng.shuffle(options)
        for receiver in options:
            if receiver in seen:
                continue
            seen.add(receiver)
            if receiver not in match_of or try_assign(match_of[receiver], seen):
                match_of[receiver] = giver
                return True
        return False

    for giver in order:
        if not try_assign(giver, set()):
            return None
    return {giver: receiver for receiver, giver in match_of.items()}


def _search(
    players: Sequence[int],
    allowed: dict[int, list[int]],
    max_mutual: int,
    node_limit: int,
    rng: random.Random,
) -> dict[int, int] | None:
    """Поиск с возвратом, допускающий не более max_mutual взаимных пар."""
    result: dict[int, int] = {}
    taken: set[int] = set()
    nodes = 0

    def pending() -> list[int]:
        return [p for p in players if p not in result]

    def solve(mutual: int) -> bool:
        nonlocal nodes
        todo = pending()
        if not todo:
            return True
        nodes += 1
        if nodes > node_limit:
            return False
        # Берём дарителя с наименьшим числом свободных вариантов.
        best_giver, best_opts = None, None
        for g in todo:
            opts = [r for r in allowed[g] if r not in taken]
            if best_opts is None or len(opts) < len(best_opts):
                best_giver, best_opts = g, opts
                if not opts:
                    return False
        assert best_giver is not None and best_opts is not None
        rng.shuffle(best_opts)
        for r in best_opts:
            is_mutual = result.get(r) == best_giver
            if is_mutual and mutual + 1 > max_mutual:
                continue
            result[best_giver] = r
            taken.add(r)
            if solve(mutual + (1 if is_mutual else 0)):
                return True
            del result[best_giver]
            taken.discard(r)
            if nodes > node_limit:
                return False
        return False

    return dict(result) if solve(0) else None


def count_mutual(assignment: dict[int, int]) -> int:
    return sum(
        1 for a, b in assignment.items() if a < b and assignment.get(b) == a
    )


def make_draw(
    players: Sequence[int],
    rules: Iterable[Iterable[int]] = (),
    rng: random.Random | None = None,
    node_limit: int = 20000,
) -> dict[int, int]:
    """Возвращает {даритель: получатель}. Бросает DrawImpossible, если решения нет."""
    rng = rng or random.SystemRandom()
    players = list(dict.fromkeys(players))
    if len(players) < 2:
        raise DrawImpossible("Слишком мало участников")
    allowed = _allowed(players, forbidden_pairs(rules))

    # Точная проверка существования решения.
    fallback = _random_matching(players, allowed, rng)
    if fallback is None:
        raise DrawImpossible("Нет распределения, удовлетворяющего правилам")

    if count_mutual(fallback) == 0:
        return fallback
    # Минимизируем число взаимных пар: бюджет 0, 1, 2, ...
    for budget in range(0, len(players) // 2 + 1):
        found = _search(players, allowed, budget, node_limit, rng)
        if found is not None:
            return found
    return fallback
