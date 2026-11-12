import { beforeEach, describe, expect, it } from "vitest";
import * as config from "../src/config";
import { Database, type Game } from "../src/db";
import { DrawImpossible, Service, UserError } from "../src/service";
import { createD1 } from "./helpers/d1";

const ORG = 1;
let svc: Service;
let game: Game;

async function join(...uids: number[]) {
  for (const u of uids) expect((await svc.join(game.code, u, `U${u}`)).result).toBe("joined");
}

beforeEach(async () => {
  svc = new Service(new Database(createD1()));
  game = await svc.createGame("Новый год", ORG, "Орг");
});

describe("игры и участники", () => {
  it("создание и вступление", async () => {
    expect(await svc.db.isPlayer(game.id, ORG)).toBe(true);
    await join(2);
    expect((await svc.join(game.code, 2, "U2")).result).toBe("already");
    expect((await svc.join("nope", 3, "x")).result).toBe("not_found");
  });
  it("валидация названия", async () => {
    await expect(svc.createGame("   ", ORG, "x")).rejects.toThrow(UserError);
    await expect(svc.createGame("a".repeat(config.MAX_TITLE_LEN + 1), ORG, "x")).rejects.toThrow(UserError);
  });
  it("коды игр уникальны и подходят для deep link", async () => {
    const g2 = await svc.createGame("Вторая", ORG, "Орг");
    expect(g2.code).not.toBe(game.code);
    expect(game.code).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("подарки", () => {
  it("лимиты: 20 пунктов и 300 символов", async () => {
    for (let i = 0; i < config.MAX_WISHES; i++) await svc.addWish(game.id, ORG, `подарок ${i}`);
    await expect(svc.addWish(game.id, ORG, "ещё")).rejects.toThrow(UserError);
    await svc.deleteWish(game.id, ORG, (await svc.db.getWishes(game.id, ORG))[0].id);
    await svc.addWish(game.id, ORG, "x".repeat(config.MAX_WISH_LEN)); // ровно по лимиту
    await svc.deleteWish(game.id, ORG, (await svc.db.getWishes(game.id, ORG))[0].id);
    await expect(svc.addWish(game.id, ORG, "x".repeat(config.MAX_WISH_LEN + 1))).rejects.toThrow(UserError);
    await expect(svc.addWish(game.id, ORG, "  ")).rejects.toThrow(UserError);
  });
  it("эмодзи считаются как один символ", async () => {
    await svc.addWish(game.id, ORG, "🎁".repeat(config.MAX_WISH_LEN));
    await expect(svc.addWish(game.id, ORG, "🎁".repeat(config.MAX_WISH_LEN + 1))).rejects.toThrow(UserError);
  });
  it("чужой пункт трогать нельзя", async () => {
    await join(2);
    const wid = await svc.addWish(game.id, 2, "книга");
    await expect(svc.editWish(game.id, ORG, wid, "взлом")).rejects.toThrow(UserError);
    await expect(svc.deleteWish(game.id, ORG, wid)).rejects.toThrow(UserError);
    await svc.editWish(game.id, 2, wid, "две книги");
    expect((await svc.db.getWish(wid))!.text).toBe("две книги");
  });
  it("не участник не может добавлять", async () => {
    await expect(svc.addWish(game.id, 99, "x")).rejects.toThrow(UserError);
  });
});

describe("правила и удаление участников", () => {
  it("правила создаёт только организатор", async () => {
    await join(2, 3);
    await expect(svc.createRule(game.id, 2, new Set([2, 3]))).rejects.toThrow(UserError);
    await expect(svc.createRule(game.id, ORG, new Set([2]))).rejects.toThrow(/минимум 2/);
    await expect(svc.createRule(game.id, ORG, new Set([2, 777]))).rejects.toThrow(UserError);
    const rid = await svc.createRule(game.id, ORG, new Set([2, 3]));
    await expect(svc.createRule(game.id, ORG, new Set([3, 2]))).rejects.toThrow(/уже есть/);
    await expect(svc.deleteRule(game.id, 2, rid)).rejects.toThrow(UserError);
    await svc.deleteRule(game.id, ORG, rid);
    expect(await svc.db.getRules(game.id)).toEqual([]);
  });
  it("удаление участника чистит его подарки и правила", async () => {
    await join(2, 3, 4);
    await svc.addWish(game.id, 3, "x");
    await svc.createRule(game.id, ORG, new Set([2, 3]));
    await svc.createRule(game.id, ORG, new Set([2, 3, 4]));
    await expect(svc.removePlayer(game.id, 2, 3)).rejects.toThrow(UserError); // не организатор
    await expect(svc.removePlayer(game.id, ORG, ORG)).rejects.toThrow(UserError);
    await svc.removePlayer(game.id, ORG, 3);
    expect(await svc.db.isPlayer(game.id, 3)).toBe(false);
    expect(await svc.db.getWishes(game.id, 3)).toEqual([]);
    expect((await svc.db.getRules(game.id)).map((r) => r.members)).toEqual([[2, 4]]);
  });
});

describe("жеребьёвка", () => {
  it("нужно минимум трое", async () => {
    await join(2);
    await expect(svc.runDraw(game.id, ORG)).rejects.toThrow(/минимум 3/);
  });
  it("только организатор и только один раз", async () => {
    await join(2, 3);
    await expect(svc.runDraw(game.id, 2)).rejects.toThrow(UserError);
    const a = await svc.runDraw(game.id, ORG);
    expect(await svc.db.getAssignments(game.id)).toEqual(a);
    await expect(svc.runDraw(game.id, ORG)).rejects.toThrow(UserError);
  });
  it("повторное сохранение результата откатывается целиком", async () => {
    await join(2, 3);
    const a = await svc.runDraw(game.id, ORG);
    expect(await svc.db.saveDraw(game.id, new Map([[1, 2], [2, 3], [3, 1]]))).toBe(false);
    expect(await svc.db.getAssignments(game.id)).toEqual(a);
  });
  it("невозможная жеребьёвка оставляет игру открытой", async () => {
    await join(2, 3);
    await svc.createRule(game.id, ORG, new Set([1, 2, 3]));
    await expect(svc.runDraw(game.id, ORG)).rejects.toThrow(DrawImpossible);
    expect((await svc.db.getGame(game.id))!.status).toBe("open");
    await svc.deleteRule(game.id, ORG, (await svc.db.getRules(game.id))[0].id);
    await svc.runDraw(game.id, ORG);
  });
  it("после жеребьёвки: вход, правила, удаление и выход закрыты, подарки редактируются", async () => {
    await join(2, 3);
    await svc.runDraw(game.id, ORG);
    expect((await svc.join(game.code, 9, "late")).result).toBe("closed");
    await expect(svc.createRule(game.id, ORG, new Set([2, 3]))).rejects.toThrow(UserError);
    await expect(svc.removePlayer(game.id, ORG, 2)).rejects.toThrow(UserError);
    await expect(svc.leave(game.id, 2)).rejects.toThrow(UserError);
    const wid = await svc.addWish(game.id, 2, "носки");
    await svc.editWish(game.id, 2, wid, "тёплые носки");
    await svc.deleteWish(game.id, 2, wid);
  });
  it("santaOf находит дарителя", async () => {
    await join(2, 3);
    expect(await svc.santaOf(game.id, 2)).toBeNull();
    const a = await svc.runDraw(game.id, ORG);
    for (const [giver, receiver] of a) expect(await svc.santaOf(game.id, receiver)).toBe(giver);
  });
  it("лимит участников", async () => {
    const old = config.MAX_PLAYERS;
    // MAX_PLAYERS — const; проверяем через заполнение реального лимита
    for (let u = 2; u <= old; u++) await svc.join(game.code, u, `U${u}`);
    expect((await svc.join(game.code, old + 1, "x")).result).toBe("full");
  });
});

describe("удаление игры", () => {
  it("организатор удаляет игру со всеми данными, чужие игры остаются", async () => {
    await join(2, 3, 4);
    await svc.addWish(game.id, 2, "книга");
    await svc.createRule(game.id, ORG, new Set([2, 3]));
    await svc.runDraw(game.id, ORG);
    const other = await svc.createGame("Другая", ORG, "Орг");
    await svc.addWish(other.id, ORG, "сохранить");

    await expect(svc.deleteGame(game.id, 2)).rejects.toThrow(UserError); // не организатор
    const { players } = await svc.deleteGame(game.id, ORG);
    expect(players.map((p) => p.user_id).sort()).toEqual([1, 2, 3, 4]);

    expect(await svc.db.getGame(game.id)).toBeNull();
    expect(await svc.db.getPlayers(game.id)).toEqual([]);
    expect(await svc.db.getWishes(game.id, 2)).toEqual([]);
    expect(await svc.db.getRules(game.id)).toEqual([]);
    expect((await svc.db.getAssignments(game.id)).size).toBe(0);
    expect((await svc.join(game.code, 9, "x")).result).toBe("not_found");
    expect((await svc.db.getWishes(other.id, ORG)).length).toBe(1);
    expect((await svc.db.gamesOfUser(ORG)).map((g) => g.id)).toEqual([other.id]);
  });
});
