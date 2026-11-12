/**
 * Жеребьёвка тайного Санты. Чистая логика без Telegram и БД.
 * Ищем перестановку «даритель -> получатель»: никто не дарит себе, внутри групп-правил
 * никто никому не достаётся, взаимных пар (A->B и B->A) как можно меньше.
 */
export class DrawImpossible extends Error {}

export type Rng = () => number; // [0, 1)

export const systemRng: Rng = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

function shuffle<T>(a: T[], rng: Rng): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

const key = (a: number, b: number) => `${a},${b}`;

export function forbiddenPairs(rules: number[][]): Set<string> {
  const pairs = new Set<string>();
  for (const group of rules) {
    for (const a of group) for (const b of group) if (a !== b) pairs.add(key(a, b));
  }
  return pairs;
}

function allowedMap(players: number[], forbidden: Set<string>): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const a of players) {
    m.set(a, players.filter((b) => b !== a && !forbidden.has(key(a, b))));
  }
  return m;
}

/** Случайное совершенное паросочетание (алгоритм Куна). null, если его нет. */
function randomMatching(players: number[], allowed: Map<number, number[]>, rng: Rng): Map<number, number> | null {
  const giverOf = new Map<number, number>(); // получатель -> даритель
  const order = [...players];
  shuffle(order, rng);

  const tryAssign = (giver: number, seen: Set<number>): boolean => {
    const options = [...allowed.get(giver)!];
    shuffle(options, rng);
    for (const receiver of options) {
      if (seen.has(receiver)) continue;
      seen.add(receiver);
      const current = giverOf.get(receiver);
      if (current === undefined || tryAssign(current, seen)) {
        giverOf.set(receiver, giver);
        return true;
      }
    }
    return false;
  };

  for (const giver of order) if (!tryAssign(giver, new Set())) return null;
  const result = new Map<number, number>();
  for (const [receiver, giver] of giverOf) result.set(giver, receiver);
  return result;
}

/** Поиск с возвратом, допускающий не более maxMutual взаимных пар. */
function search(
  players: number[],
  allowed: Map<number, number[]>,
  maxMutual: number,
  nodeLimit: number,
  rng: Rng,
): Map<number, number> | null {
  const result = new Map<number, number>();
  const taken = new Set<number>();
  let nodes = 0;

  const solve = (mutual: number): boolean => {
    const todo = players.filter((p) => !result.has(p));
    if (todo.length === 0) return true;
    if (++nodes > nodeLimit) return false;
    // Даритель с наименьшим числом свободных вариантов.
    let bestGiver = -1;
    let bestOpts: number[] | null = null;
    for (const g of todo) {
      const opts = allowed.get(g)!.filter((r) => !taken.has(r));
      if (bestOpts === null || opts.length < bestOpts.length) {
        bestGiver = g;
        bestOpts = opts;
        if (opts.length === 0) return false;
      }
    }
    const opts = bestOpts!;
    shuffle(opts, rng);
    for (const r of opts) {
      const isMutual = result.get(r) === bestGiver;
      if (isMutual && mutual + 1 > maxMutual) continue;
      result.set(bestGiver, r);
      taken.add(r);
      if (solve(mutual + (isMutual ? 1 : 0))) return true;
      result.delete(bestGiver);
      taken.delete(r);
      if (nodes > nodeLimit) return false;
    }
    return false;
  };

  return solve(0) ? new Map(result) : null;
}

export function countMutual(a: Map<number, number>): number {
  let n = 0;
  for (const [x, y] of a) if (x < y && a.get(y) === x) n++;
  return n;
}

/** {даритель -> получатель}. Бросает DrawImpossible, если решения нет. */
export function makeDraw(
  playersIn: number[],
  rules: number[][] = [],
  rng: Rng = systemRng,
  nodeLimit = 5000,
): Map<number, number> {
  const players = [...new Set(playersIn)];
  if (players.length < 2) throw new DrawImpossible("Слишком мало участников");
  const allowed = allowedMap(players, forbiddenPairs(rules));

  // Точная проверка существования решения.
  const fallback = randomMatching(players, allowed, rng);
  if (fallback === null) throw new DrawImpossible("Нет распределения, удовлетворяющего правилам");
  if (countMutual(fallback) === 0) return fallback;

  // Минимизируем число взаимных пар: бюджет 0, 1, 2, ...
  for (let budget = 0; budget <= Math.floor(players.length / 2); budget++) {
    const found = search(players, allowed, budget, nodeLimit, rng);
    if (found !== null) return found;
  }
  return fallback;
}
