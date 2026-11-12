import { describe, expect, it } from "vitest";
import { DrawImpossible, countMutual, forbiddenPairs, makeDraw, type Rng } from "../src/draw";

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkValid(a: Map<number, number>, players: number[], rules: number[][]) {
  expect([...a.keys()].sort((x, y) => x - y)).toEqual([...players].sort((x, y) => x - y));
  expect([...a.values()].sort((x, y) => x - y)).toEqual([...players].sort((x, y) => x - y));
  const bad = forbiddenPairs(rules);
  for (const [g, r] of a) {
    expect(g).not.toBe(r);
    expect(bad.has(`${g},${r}`)).toBe(false);
  }
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const seeds = range(1, 40);

describe("makeDraw", () => {
  it.each(seeds)("без правил: нет себя и взаимных пар (seed %i)", (s) => {
    const p = range(1, 7);
    const a = makeDraw(p, [], mulberry32(s));
    checkValid(a, p, []);
    expect(countMutual(a)).toBe(0);
  });

  it("трое — всегда цикл без взаимных пар", () => {
    for (const s of seeds) {
      const a = makeDraw([1, 2, 3], [], mulberry32(s));
      checkValid(a, [1, 2, 3], []);
      expect(countMutual(a)).toBe(0);
    }
  });

  it.each(seeds)("правила соблюдаются (seed %i)", (s) => {
    const p = range(1, 8);
    const rules = [[1, 2], [3, 4, 5], [6, 7]];
    checkValid(makeDraw(p, rules, mulberry32(s)), p, rules);
  });

  it("пересекающиеся правила", () => {
    const p = range(1, 6);
    const rules = [[1, 2, 3], [3, 4], [4, 5, 6]];
    for (const s of seeds) checkValid(makeDraw(p, rules, mulberry32(s)), p, rules);
  });

  it("невозможно: слишком большая группа", () => {
    expect(() => makeDraw(range(1, 6), [[1, 2, 3, 4]], mulberry32(0))).toThrow(DrawImpossible);
  });
  it("невозможно: все в одной группе", () => {
    expect(() => makeDraw([1, 2, 3], [[1, 2, 3]], mulberry32(0))).toThrow(DrawImpossible);
  });
  it("невозможно: один участник", () => {
    expect(() => makeDraw([1], [], mulberry32(0))).toThrow(DrawImpossible);
  });
  it("невозможно: трое могут дарить только четвёртому", () => {
    expect(() => makeDraw([1, 2, 3, 4], [[1, 2], [1, 3], [2, 3]], mulberry32(0))).toThrow(DrawImpossible);
  });

  it("две «семьи» раздаются по кругу без взаимных пар", () => {
    const rules = [[1, 2], [3, 4]];
    for (const s of seeds) {
      const a = makeDraw([1, 2, 3, 4], rules, mulberry32(s));
      checkValid(a, [1, 2, 3, 4], rules);
      expect(countMutual(a)).toBe(0);
    }
  });

  it("вынужденная взаимная пара разрешена", () => {
    const rules = [[1, 3], [1, 4], [2, 3], [2, 4]];
    for (const s of seeds) {
      const a = makeDraw([1, 2, 3, 4], rules, mulberry32(s));
      checkValid(a, [1, 2, 3, 4], rules);
      expect(a.get(1)).toBe(2);
      expect(a.get(2)).toBe(1);
    }
  });

  it("число взаимных пар минимально", () => {
    const rules = [[1, 3], [1, 4], [1, 5], [1, 6], [2, 3], [2, 4], [2, 5], [2, 6]];
    for (const s of seeds) {
      const a = makeDraw(range(1, 6), rules, mulberry32(s));
      checkValid(a, range(1, 6), rules);
      expect(countMutual(a)).toBe(1);
    }
  });

  it("игра на 50 человек", () => {
    const p = range(1, 50);
    const rules = range(0, 24).map((i) => [2 * i + 1, 2 * i + 2]);
    const t0 = performance.now();
    for (const s of range(1, 20)) {
      const a = makeDraw(p, rules, mulberry32(s));
      checkValid(a, p, rules);
      expect(countMutual(a)).toBe(0);
    }
    // 20 жеребьёвок — быстро (на Workers Free лимит 10 мс CPU на запрос)
    expect((performance.now() - t0) / 20).toBeLessThan(10);
  });

  it("результат не константа", () => {
    const seen = new Set(seeds.map((s) => JSON.stringify([...makeDraw(range(1, 5), [], mulberry32(s))])));
    expect(seen.size).toBeGreaterThan(5);
  });
});
