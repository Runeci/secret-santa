import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../src/db";
import { type OutMsg, type Outbox } from "../src/outbox";
import { runReminders } from "../src/reminders";
import { Service, UserError } from "../src/service";
import { createD1 } from "./helpers/d1";
import { Env, plain } from "./helpers/telegram";

const at = (iso: string) => Date.parse(iso + "Z");

describe("Service.setDeadline", () => {
  let svc: Service;
  let gid: number;
  beforeEach(async () => {
    svc = new Service(new Database(createD1()));
    gid = (await svc.createGame("Игра", 1, "Орг")).id;
    await svc.join((await svc.db.getGame(gid))!.code, 2, "А");
  });
  const NOW = at("2026-11-13T12:00:00");

  it("организатор ставит, меняет и убирает дедлайн", async () => {
    const g = await svc.setDeadline(gid, 1, { y: 2026, m: 12, d: 20 }, 3, NOW);
    expect([g.deadline_date, g.tz_offset]).toEqual(["2026-12-20", 3]);
    expect(g.last_reminded_day).toBe("2026-11-13"); // сегодняшний день помечен — напоминания начнутся позже
    const g2 = await svc.setDeadline(gid, 1, { y: 2026, m: 12, d: 25 }, 2, NOW);
    expect([g2.deadline_date, g2.tz_offset]).toEqual(["2026-12-25", 2]);
    await svc.clearDeadline(gid, 1);
    const g3 = (await svc.db.getGame(gid))!;
    expect([g3.deadline_date, g3.last_reminded_day]).toEqual([null, null]);
  });
  it("участнику нельзя", async () => {
    await expect(svc.setDeadline(gid, 2, { y: 2026, m: 12, d: 20 }, 3, NOW)).rejects.toThrow(UserError);
    await expect(svc.clearDeadline(gid, 2)).rejects.toThrow(UserError);
  });
  it("в прошлом по выбранному поясу нельзя; сегодня и «вчера в другом поясе» — по расчёту", async () => {
    // 12 ноября, 23:00 UTC: в UTC+3 уже 13 ноября → 13.11 допустимо, 12.11 — нет
    const n = at("2026-11-12T23:00:00");
    await svc.setDeadline(gid, 1, { y: 2026, m: 11, d: 13 }, 3, n);
    await expect(svc.setDeadline(gid, 1, { y: 2026, m: 11, d: 12 }, 3, n)).rejects.toThrow(/прошла/);
    // в UTC+0 в тот же момент ещё 12 ноября: 12.11 допустимо
    await svc.setDeadline(gid, 1, { y: 2026, m: 11, d: 12 }, 0, n);
  });
  it("часовой пояс проверяется: только UTC+0…+12", async () => {
    for (const tz of [0, 12]) await svc.setDeadline(gid, 1, { y: 2026, m: 12, d: 20 }, tz, NOW);
    for (const tz of [13, 15, -1, -5, -13, 2.5, NaN]) await expect(svc.setDeadline(gid, 1, { y: 2026, m: 12, d: 20 }, tz, NOW)).rejects.toThrow(/часовой пояс/);
  });
  it("после жеребьёвки менять и убирать нельзя", async () => {
    await svc.join((await svc.db.getGame(gid))!.code, 3, "Б");
    for (const p of await svc.db.getPlayers(gid)) {
      await svc.db.addWish(gid, p.user_id, "x");
      await svc.db.setReady(gid, p.user_id, true);
    }
    await svc.runDraw(gid, 1);
    await expect(svc.setDeadline(gid, 1, { y: 2026, m: 12, d: 20 }, 3, NOW)).rejects.toThrow(/уже проведена/);
    await expect(svc.clearDeadline(gid, 1)).rejects.toThrow(/уже проведена/);
  });
  it("ошибка разбора даты — UserError", () => {
    expect(() => svc.parseDeadlineDate("завтра", NOW)).toThrow(UserError);
    expect(svc.parseDeadlineDate("20.12", NOW)).toEqual({ y: 2026, m: 12, d: 20 });
  });
});

describe("runReminders: кому и когда приходят напоминания", () => {
  let db: Database;
  let gid: number;
  let sent: OutMsg[];
  const outbox: Outbox = { send: async (m) => void sent.push(...m) };

  beforeEach(async () => {
    db = new Database(createD1());
    const svc = new Service(db);
    const g = await svc.createGame("Офис", 1, "Орг");
    gid = g.id;
    for (const u of [2, 3, 4]) await svc.join(g.code, u, `U${u}`);
    // готов только участник 2
    await db.addWish(gid, 2, "книга");
    await db.setReady(gid, 2, true);
    await db.setDeadline(gid, "2026-11-25", 3, "2026-11-01");
    sent = [];
  });
  const chats = () => sent.map((m) => m.chat).sort();

  it("в обычный день — тишина; в субботу напоминают только не готовым", async () => {
    expect(await runReminders(db, outbox, at("2026-11-18T09:00:00"))).toBe(0); // среда
    expect(await runReminders(db, outbox, at("2026-11-14T09:00:00"))).toBe(3); // суббота 12:00 по UTC+3
    expect(chats()).toEqual([1, 3, 4]); // организатор тоже участник и тоже не готов; готовый «2» не беспокоим
    expect(sent.every((m) => m.markup && /Открыть игру/.test(JSON.stringify(m.markup)))).toBe(true);
    expect(sent[0].text).toContain("до дедлайна 11 дней");
    expect(plain(sent[0].text)).toContain("25.11.2026");
  });
  it("в тот же день повторно не шлёт (почасовой запуск), на следующей неделе — снова", async () => {
    await runReminders(db, outbox, at("2026-11-14T09:00:00"));
    sent = [];
    expect(await runReminders(db, outbox, at("2026-11-14T10:00:00"))).toBe(0);
    expect(await runReminders(db, outbox, at("2026-11-14T15:00:00"))).toBe(0);
    await db.setReady(gid, 3, false); // ничего не поменялось
    await db.addWish(gid, 3, "чай");
    await db.setReady(gid, 3, true); // участник 3 стал готов
    expect(await runReminders(db, outbox, at("2026-11-21T09:00:00"))).toBe(2); // следующая суббота: 1 и 4
    expect(chats()).toEqual([1, 4]);
  });
  it("за день до дедлайна: напоминания не готовым + сводка организатору", async () => {
    const n = await runReminders(db, outbox, at("2026-11-24T09:00:00")); // вторник
    const toOrg = sent.filter((m) => m.chat === 1).map((m) => plain(m.text));
    expect(n).toBe(4); // 1, 3, 4 — напоминания; ещё одна сводка организатору
    expect(toOrg.length).toBe(2);
    expect(toOrg.some((m) => m.includes("завтра последний день") && m.includes("Списки ещё не готовы у"))).toBe(true);
    expect(toOrg.join("\n")).toContain("U3 — нет подарков");
    expect(sent.filter((m) => m.chat === 3).length).toBe(1);
  });
  it("в день дедлайна — только сводка организатору; после — тишина", async () => {
    expect(await runReminders(db, outbox, at("2026-11-25T09:00:00"))).toBe(1);
    expect(sent[0].chat).toBe(1);
    expect(plain(sent[0].text)).toContain("сегодня последний день");
    sent = [];
    expect(await runReminders(db, outbox, at("2026-11-26T09:00:00"))).toBe(0);
  });
  it("все готовы — никому ничего", async () => {
    for (const u of [1, 3, 4]) {
      await db.addWish(gid, u, "подарок");
      await db.setReady(gid, u, true);
    }
    expect(await runReminders(db, outbox, at("2026-11-14T09:00:00"))).toBe(0);
    expect(await runReminders(db, outbox, at("2026-11-24T09:00:00"))).toBe(0);
    expect(await runReminders(db, outbox, at("2026-11-25T09:00:00"))).toBe(0);
  });
  it("разыгранные игры и игры без дедлайна не трогаем", async () => {
    const svc = new Service(db);
    const other = await svc.createGame("Без дедлайна", 1, "Орг");
    await svc.join(other.code, 2, "U2");
    sent = [];
    await runReminders(db, outbox, at("2026-11-14T09:00:00"));
    expect(sent.every((m) => !plain(m.text).includes("Без дедлайна"))).toBe(true);
  });
  it("после жеребьёвки напоминания прекращаются", async () => {
    for (const p of await db.getPlayers(gid)) {
      if (!(await db.getWishes(gid, p.user_id)).length) await db.addWish(gid, p.user_id, "x");
      await db.setReady(gid, p.user_id, true);
    }
    await new Service(db).runDraw(gid, 1);
    expect((await db.gamesWithDeadline()).length).toBe(0);
    expect(await runReminders(db, outbox, at("2026-11-24T09:00:00"))).toBe(0);
  });
  it("сбой рассылки не помечает день: повтор в следующий запуск", async () => {
    const failing: Outbox = {
      send: async () => {
        throw new Error("queue down");
      },
    };
    await expect(runReminders(db, failing, at("2026-11-14T09:00:00"))).rejects.toThrow("queue down");
    expect((await db.getGame(gid))!.last_reminded_day).toBe("2026-11-01"); // не изменилось
    sent = [];
    expect(await runReminders(db, outbox, at("2026-11-14T10:00:00"))).toBe(3); // следующий час — отправили
  });
  it("часовой пояс организатора: у UTC+10 суббота 12:00 наступает в 02:00 по UTC", async () => {
    await db.setDeadline(gid, "2026-11-25", 10, "2026-11-01");
    expect(await runReminders(db, outbox, at("2026-11-13T23:00:00"))).toBe(0); // у организатора суббота 09:00 — рано
    expect(await runReminders(db, outbox, at("2026-11-14T02:00:00"))).toBe(3); // суббота 12:00
  });
});
