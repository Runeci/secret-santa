import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, Env, plain } from "./helpers/telegram";

let env: Env;
beforeEach(() => {
  env = new Env();
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void env.errors.push(a));
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(env.errors).toEqual([]);
});

const ddmmyyyy = (daysAhead: number) => {
  const t = new Date(Date.now() + daysAhead * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`;
};

async function setup() {
  const org = env.user(1, "Орг"), ann = env.user(2, "Аня"), bob = env.user(3, "Боб");
  await org.say("/new");
  await org.say("Офис");
  const code = /start=(\S+)/.exec(org.inbox().at(-2)!)![1];
  for (const u of [ann, bob]) await u.say(`/start ${code}`);
  const gid = (await env.db.getGameByCode(code))!.id;
  return { org, ann, bob, code, gid };
}

async function openDeadline(org: Client) {
  await org.say("/start");
  await org.click("Управление");
  await org.click("Дедлайн");
}

describe("дедлайн в боте", () => {
  it("организатор задаёт дату и пояс; участники получают уведомление и видят дедлайн в меню", async () => {
    const { org, ann, bob, gid } = await setup();
    await openDeadline(org);
    expect(org.last()).toContain("Дедлайн не задан");
    expect(org.hasButton("Убрать дедлайн")).toBe(false);

    await org.click("Задать дедлайн");
    await org.say("послезавтра"); // не дата
    expect(org.last()).toContain("Не понял дату");
    await org.say("31.02"); // нет такой даты
    expect(org.last()).toContain("не существует");
    await org.say("01.01.2020"); // прошла
    expect(org.last()).toContain("прошла");
    expect(org.hasButton("Отмена")).toBe(true); // ввод не потерян: можно исправить

    await org.say(ddmmyyyy(10));
    expect(org.last()).toContain("В каком часовом поясе");
    expect(org.hasButton("UTC+3")).toBe(true);
    await org.click("UTC+3");

    const g = (await env.db.getGame(gid))!;
    expect(g.tz_offset).toBe(3);
    expect(g.deadline_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(org.last()).toMatch(/📅 Дедлайн: до \d{2}\.\d{2}\.\d{4} \(осталось \d+ дн/);
    expect(org.last()).toContain("UTC+3");
    expect(org.hasButton("Изменить дату") && org.hasButton("Убрать дедлайн")).toBe(true);

    // участникам — уведомление; в меню игры у всех строка про дедлайн
    for (const u of [ann, bob]) {
      expect(u.inbox().some((m) => m.includes("назначен дедлайн") && m.includes("UTC+3"))).toBe(true);
    }
    expect(org.inbox().some((m) => m.includes("назначен дедлайн"))).toBe(false); // организатору своё уведомление не шлём
    await ann.say("/start");
    expect(ann.last()).toMatch(/📅 Дедлайн: до \d{2}\.\d{2}\.\d{4}/);
  });

  it("можно изменить дату, затем убрать: участники уведомлены, строка из меню исчезает", async () => {
    const { org, ann, gid } = await setup();
    await openDeadline(org);
    await org.click("Задать дедлайн");
    await org.say(ddmmyyyy(5));
    await org.click("UTC+2");
    await org.click("Изменить дату");
    await org.say(ddmmyyyy(20));
    await org.click("UTC+5");
    const g = (await env.db.getGame(gid))!;
    expect(g.tz_offset).toBe(5);

    await org.click("Убрать дедлайн");
    expect(org.last()).toContain("Дедлайн не задан");
    expect((await env.db.getGame(gid))!.deadline_date).toBeNull();
    expect(ann.inbox().some((m) => m.includes("дедлайн отменён"))).toBe(true);
    await ann.say("/start");
    expect(ann.last()).not.toContain("Дедлайн");
  });

  it("текст «завтра / сегодня / прошёл» в меню", async () => {
    const { org, ann, gid } = await setup();
    const local = (n: number) => {
      const t = new Date(Date.now() + 3 * 3_600_000 + n * 86_400_000); // дата в UTC+3
      return t.toISOString().slice(0, 10);
    };
    for (const [offset, text] of [[1, "завтра"], [0, "сегодня"], [-2, "Дедлайн прошёл"]] as const) {
      await env.db.setDeadline(gid, local(offset), 3, "2000-01-01");
      await ann.say("/start");
      expect(ann.last(), String(offset)).toContain(text);
    }
  });

  it("участник не может ни открыть, ни менять дедлайн (подделанные кнопки)", async () => {
    const { org, ann, gid } = await setup();
    for (const data of [`dl:${gid}`, `dls:${gid}`, `dlx:${gid}`, `dz:${gid}:20991231:3`]) {
      env.alerts.length = 0;
      await ann.rawCallback(data);
      expect(env.alerts.at(-1)?.toLowerCase(), data).toContain("организатор");
    }
    expect((await env.db.getGame(gid))!.deadline_date).toBeNull();
    void org;
  });

  it("старая кнопка с прошедшей датой отклоняется; неверный пояс тоже", async () => {
    const { org, gid } = await setup();
    await org.say("/start");
    await org.rawCallback(`dz:${gid}:20200101:3`);
    expect(env.alerts.at(-1)).toContain("прошла");
    await org.rawCallback(`dz:${gid}:20991231:99`);
    expect(env.alerts.at(-1)).toContain("часовой пояс");
    expect((await env.db.getGame(gid))!.deadline_date).toBeNull();
  });

  it("после жеребьёвки дедлайна в «Управлении» нет и менять нельзя", async () => {
    const { org, gid } = await setup();
    await openDeadline(org);
    await org.click("Задать дедлайн");
    await org.say(ddmmyyyy(7));
    await org.click("UTC+3");
    for (const p of await env.db.getPlayers(gid)) {
      await env.db.addWish(gid, p.user_id, "x");
      await env.db.setReady(gid, p.user_id, true);
    }
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    await org.click("Управление");
    expect(org.hasButton("Дедлайн")).toBe(false);
    expect(org.last()).not.toContain("📅 Дедлайн");
    await org.rawCallback(`dz:${gid}:20991231:3`);
    expect(env.alerts.at(-1)).toContain("уже проведена");
  });

  it("в «Управлении» и меню организатора есть строка с дедлайном", async () => {
    const { org } = await setup();
    await openDeadline(org);
    await org.click("Задать дедлайн");
    await org.say(ddmmyyyy(9));
    await org.click("UTC+3");
    await org.click("Управление");
    expect(org.last()).toMatch(/📅 Дедлайн: до/);
    expect(plain(org.last())).toContain("Вы — организатор");
  });
});
