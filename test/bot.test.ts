import { beforeEach, describe, expect, it } from "vitest";
import { BOT_USERNAME, Client, Env, plain } from "./helpers/telegram";

let env: Env;

/** Всем участникам игры без подарков добавляет по одному (жеребьёвка требует подарки у всех). */
async function wishAll(code: string) {
  const gid = (await env.db.getGameByCode(code))!.id;
  for (const p of await env.db.getPlayers(gid))
    if (!(await env.db.getWishes(gid, p.user_id)).length) await env.db.addWish(gid, p.user_id, "подарок");
}

beforeEach(() => {
  env = new Env();
});

async function createGame(org: Client, title = "Офис 2026"): Promise<string> {
  await org.say("/new");
  expect(org.last()).toContain("назовём");
  await org.say(title);
  return /start=(\S+)/.exec(org.inbox().at(-2)!)![1];
}

describe("полный сценарий", () => {
  it("игра от создания до анонимных уведомлений", async () => {
    const org = env.user(1, "Организатор"), ann = env.user(2, "Аня"), bob = env.user(3, "Боб"), cat = env.user(4, "Катя");
    const code = await createGame(org);
    expect(org.inbox().at(-2)).toContain(`t.me/${BOT_USERNAME}?start=${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;

    // регистрация + уведомление организатору
    for (const u of [ann, bob, cat]) {
      await u.say(`/start ${code}`);
      expect(u.inbox().at(-2)).toContain("Вы в игре");
    }
    expect(org.inbox().some((m) => m.includes("Новый участник") && m.includes("Аня"))).toBe(true);
    expect((await env.db.getPlayers(gid)).length).toBe(4);

    // список подарков: добавить, изменить
    await ann.click("Добавить подарок");
    await ann.say("Книга <Дюна>");
    expect(ann.last()).toContain("Добавлено");
    expect(ann.last()).toContain("Книга <Дюна>");
    await ann.click("Добавить ещё");
    await ann.say("Носки");
    await ann.click("Мой список");
    await ann.click("Носки");
    await ann.click("Изменить");
    await ann.say("Тёплые носки");
    expect(ann.last()).toContain("Тёплые носки");
    await bob.click("Добавить подарок");
    await bob.say("Кофе");
    await cat.click("Добавить подарок");
    await cat.say("Плед");

    // лимиты: слишком длинный текст, состояние сохраняется
    await bob.click("Добавить ещё");
    await bob.say("x".repeat(2001));
    expect(bob.last()).toContain("Слишком длинно");
    await bob.say("Чай");
    expect(bob.last()).toContain("Добавлено");

    // участник не видит управления и «Кому я дарю» до жеребьёвки
    await ann.click("В меню игры");
    expect(ann.hasButton("Управление")).toBe(false);
    expect(ann.hasButton("Кому я дарю")).toBe(false);

    // правило: Аня и Боб живут вместе
    await org.click("Управление");
    await org.click("Правила");
    await org.click("Добавить правило");
    await org.click("Аня");
    await org.click("Сохранить");
    expect(env.alerts.at(-1)).toContain("минимум 2");
    await org.click("Боб");
    await org.click("Сохранить");
    expect(org.last()).toContain("Аня");
    expect(org.last()).toContain("Боб");
    expect((await env.db.getRules(gid))[0].members).toEqual([2, 3]);

    // удаление участника до жеребьёвки
    await org.click("Управление");
    await org.click("Участники");
    expect(org.buttons().some((b) => b.text.includes("Организатор") && b.text.includes("Убрать"))).toBe(false);
    await org.click("Убрать: Катя");
    await org.click("Убрать");
    expect(await env.db.isPlayer(gid, 4)).toBe(false);
    expect(cat.inbox().some((m) => m.includes("убрал вас"))).toBe(true);

    // трое, но правило «Аня+Боб» делает жеребьёвку невозможной
    await org.click("Управление");
    await wishAll(code);
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("невозможна");
    expect((await env.db.getGame(gid))!.status).toBe("open");

    // Катя возвращается
    await cat.say(`/start ${code}`);
    await cat.click("Добавить подарок");
    await cat.say("Плед");

    // жеребьёвка
    await org.click("Управление");
    await wishAll(code);
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("Жеребьёвка проведена");
    for (const u of [org, ann, bob, cat]) expect(u.inbox().some((m) => m.includes("Тайный Санта для"))).toBe(true);
    const a = await env.db.getAssignments(gid);
    expect(a.get(2)).not.toBe(3);
    expect(a.get(3)).not.toBe(2);
    for (const [g, r] of a) expect(g).not.toBe(r);

    const names: Record<number, string> = { 1: "Организатор", 2: "Аня", 3: "Боб", 4: "Катя" };
    const users: Record<number, Client> = { 1: org, 2: ann, 3: bob, 4: cat };
    for (const [giver, receiver] of a) {
      const dm = users[giver].inbox().find((m) => m.includes("Тайный Санта для"))!;
      expect(dm).toContain(names[receiver]);
    }
    // организатор видит только свою пару
    const orgDms = org.inbox().filter((m) => m.includes("Тайный Санта для"));
    expect(orgDms.length).toBe(1);
    expect(orgDms[0]).toContain(names[a.get(1)!]);

    // кнопка «Кому я дарю»
    await ann.say("/start");
    await ann.click("Кому я дарю");
    expect(ann.last()).toContain(names[a.get(2)!]);

    // после жеребьёвки
    const late = env.user(9, "Опоздавший");
    await late.say(`/start ${code}`);
    expect(late.inbox().at(-2)).toContain("вступить нельзя");
    expect(await env.db.isPlayer(gid, 9)).toBe(false);
    await org.say("/start");
    await org.click("Управление");
    expect(org.hasButton("жеребьёвку")).toBe(false);
    await org.click("Правила");
    expect(org.hasButton("Добавить правило") || org.hasButton("Удалить")).toBe(false);
    await org.click("Управление");
    await org.click("Участники");
    expect(org.hasButton("Убрать")).toBe(false);

    // изменение списка после жеребьёвки -> анонимное сообщение Санте
    const santaOfAnn = users[(await env.db.getGiver(gid, 2))!];
    let n = santaOfAnn.inbox().length;
    await ann.say("/start");
    await ann.click("Добавить подарок");
    await ann.say("Шоколад");
    const notes = santaOfAnn.inbox().slice(n).filter((m) => m.includes("обновил"));
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("Шоколад");
    expect(notes[0]).toContain("Тёплые носки");
    expect(ann.inbox().some((m) => m.includes("обновил"))).toBe(false); // получатель не узнаёт Санту

    // удаление тоже уведомляет
    n = santaOfAnn.inbox().length;
    await ann.click("Мой список");
    await ann.click("Шоколад");
    await ann.click("Удалить");
    expect(santaOfAnn.inbox().slice(n).some((m) => m.includes("обновил") && !m.includes("Шоколад"))).toBe(true);

    // правка у Боба уведомляет его Санту
    const santaOfBob = users[(await env.db.getGiver(gid, 3))!];
    n = santaOfBob.inbox().length;
    await bob.say("/start");
    await bob.click("Мой список");
    await bob.click("Чай");
    await bob.click("Изменить");
    await bob.say("Зелёный чай");
    expect(santaOfBob.inbox().slice(n).some((m) => m.includes("Зелёный чай"))).toBe(true);
  });
});

describe("отдельные сценарии", () => {
  it("жеребьёвка нужна минимум на троих", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А");
    const code = await createGame(org);
    await a.say(`/start ${code}`);
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    expect(env.alerts.at(-1)).toContain("минимум 3");
  });

  it("невозможно -> удалили правило -> получилось", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А"), b = env.user(3, "Б");
    const code = await createGame(org);
    for (const u of [a, b]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    await org.click("Управление");
    await org.click("Правила");
    await org.click("Добавить правило");
    for (const n of ["Орг", "А", "Б"]) await org.click(n);
    await org.click("Сохранить");
    await org.click("Управление");
    await wishAll(code);
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("невозможна");
    expect(org.hasButton("Открыть правила")).toBe(true);
    await org.click("Открыть правила");
    await org.click("🗑 1.");
    await org.click("Управление");
    await wishAll(code);
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("Жеребьёвка проведена");
    expect((await env.db.getGame(gid))!.status).toBe("drawn");
  });

  it("участник не может нажимать организаторские кнопки", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А");
    const code = await createGame(org);
    await a.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    for (const data of [`mdy:${gid}`, `mra:${gid}`, `mpy:${gid}:1`, `m:${gid}`, `ml:${gid}`]) {
      env.alerts.length = 0;
      await a.rawCallback(data);
      expect(env.alerts.at(-1)?.toLowerCase(), data).toContain("организатор");
    }
    expect((await env.db.getGame(gid))!.status).toBe("open");
    expect(await env.db.isPlayer(gid, 1)).toBe(true);
  });

  it("несколько игр и выход из игры", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А");
    const c1 = await createGame(org, "Игра один");
    const c2 = await createGame(org, "Игра два");
    await a.say(`/start ${c1}`);
    await a.say(`/start ${c2}`);
    await a.say("/start");
    expect(a.last()).toContain("Ваши игры");
    expect(a.hasButton("Игра один") && a.hasButton("Игра два")).toBe(true);
    await a.click("Игра один");
    await a.click("Выйти из игры");
    await a.click("Да, выйти");
    expect(await env.db.isPlayer((await env.db.getGameByCode(c1))!.id, 2)).toBe(false);
    expect(org.inbox().some((m) => m.includes("вышел"))).toBe(true);
  });

  it("заблокировавшему бота доставка не удалась: организатор узнаёт, пара не раскрывается", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А"), b = env.user(3, "Б");
    const code = await createGame(org);
    for (const u of [a, b]) await u.say(`/start ${code}`);
    env.blocked.add(3);
    await org.click("Управление");
    await wishAll(code);
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    const warn = org.inbox().find((m) => m.includes("Не удалось доставить"))!;
    expect(warn).toContain("Б");
    expect(warn).not.toContain("Санта для");
    env.blocked.clear();
    await b.say("/start");
    await b.click("Кому я дарю");
    expect(b.last()).toContain("Тайный Санта для");
  });

  it("неверная ссылка и устаревшие кнопки", async () => {
    const u = env.user(5, "Z");
    await u.say("/start doesnotexist");
    expect(u.inbox().some((m) => m.includes("не найдена"))).toBe(true);
    await u.rawCallback("zzz:1");
    expect(env.alerts.at(-1)).toContain("устарела");
    await u.rawCallback("g:abc");
    expect(env.alerts.at(-1)).toContain("устарела");
  });

  it("HTML в названиях экранируется", async () => {
    const org = env.user(1, "Орг");
    await org.say("/new");
    await org.say("<b>Игра</b> & co");
    const raw = env.sent.filter((s) => s.chat === 1).map((s) => s.text);
    expect(raw.some((m) => m.includes("&lt;b&gt;Игра&lt;/b&gt; &amp; co"))).toBe(true);
    expect(plain(raw.at(-1)!)).toContain("<b>Игра</b> & co");
  });

  it("текст без состояния и нетекстовые сообщения не ломают бота", async () => {
    const u = env.user(7, "Y");
    await u.say("привет");
    expect(u.last()).toContain("Не понял");
    await env.bot.handleUpdate({
      update_id: env.nextId(),
      message: { message_id: 1, date: 0, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "Y" }, photo: [] },
    } as any);
    expect(u.last()).toContain("Не понял");
  });

  it("состояние диалога сбрасывается при смене экрана", async () => {
    const org = env.user(1, "Орг");
    await createGame(org);
    await org.click("Добавить подарок");
    await org.click("Отмена"); // ушли с ввода — состояние сброшено
    await org.say("это не подарок");
    expect(org.last()).toContain("Не понял");
  });
});

describe("удаление игры", () => {
  it("с подтверждением, участники получают уведомление, их данные стёрты", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А"), b = env.user(3, "Б");
    const code = await createGame(org, "Удаляемая");
    const keep = await createGame(org, "Остаётся");
    for (const u of [a, b]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    await a.click("Добавить подарок");
    await a.say("книга");

    // участник удалить не может
    await a.rawCallback(`mx:${gid}`);
    expect(env.alerts.at(-1)?.toLowerCase()).toContain("организатор");
    await a.rawCallback(`mxy:${gid}`);
    expect(await env.db.getGame(gid)).not.toBeNull();

    // организатор: подтверждение, потом удаление (даже после жеребьёвки)
    await org.say("/start");
    await org.click("Удаляемая");
    await org.click("Управление");
    await wishAll(code);
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    await org.click("Управление");
    await org.click("Удалить игру");
    expect(org.last()).toContain("Удалить игру «Удаляемая»");
    await org.click("Отмена");
    expect(await env.db.getGame(gid)).not.toBeNull();
    await org.click("Удалить игру");
    await org.click("Да, удалить");

    expect(await env.db.getGame(gid)).toBeNull();
    expect((await env.db.getAssignments(gid)).size).toBe(0);
    expect(await env.db.getWishes(gid, 2)).toEqual([]);
    for (const u of [a, b]) expect(u.inbox().some((m) => m.includes("удалил игру «Удаляемая»"))).toBe(true);
    expect(org.inbox().some((m) => m.includes("удалил игру"))).toBe(false); // себя не уведомляем
    expect(org.last()).toContain("Остаётся"); // остался экран с оставшейся игрой
    expect(await env.db.getGameByCode(keep)).not.toBeNull();

    // у участника старые кнопки больше не работают
    await a.rawCallback(`g:${gid}`);
    expect(env.alerts.at(-1)).toContain("не участвуете");
  });
});

describe("длинные списки и ссылки", () => {
  const url = (n: number) => `https://shop.example/item?id=${n}&utm=a<b>&x=` + "z".repeat(1400);

  it("длинная ссылка принимается; 20 длинных пунктов целиком доходят до Санты несколькими сообщениями", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А"), b = env.user(3, "Б");
    const code = await createGame(org);
    for (const u of [a, b]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;

    await a.click("Добавить подарок");
    await a.say(url(0));
    expect(a.last()).toContain("Добавлено");
    for (let i = 1; i < 20; i++) {
      await a.click("Добавить ещё");
      await a.say(url(i));
      expect(a.last()).toContain("Добавлено");
    }
    // экран «Мой список» и сообщение после добавления помещаются в одно сообщение
    await a.click("Мой список");
    expect(a.last().length).toBeLessThanOrEqual(4096);
    expect(a.last()).toContain("сокращены");
    // полный текст пункта — на его карточке
    await a.click("1.");
    expect(a.last()).toContain(url(0).slice(0, 80));

    await org.click("Управление");
    await wishAll(code);
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("Жеребьёвка проведена");

    const receiverOfSanta = new Map(await env.db.getAssignments(gid));
    const santaOfA = [...receiverOfSanta].find(([, r]) => r === 2)![0];
    const santa = env.user(santaOfA, "x");
    const dm = env.sent.filter((s) => s.chat === santaOfA && /Тайный Санта для|продолжение/.test(plain(s.text)));
    expect(dm.length).toBeGreaterThan(1); // список не влез в одно сообщение
    for (const m of dm) expect(plain(m.text).length).toBeLessThanOrEqual(4096);
    const all = dm.map((m) => plain(m.text)).join("\n");
    for (let i = 0; i < 20; i++) expect(all).toContain(url(i)); // все ссылки целиком и по порядку
    expect(dm.at(-1)!.markup).toBeTruthy(); // кнопка только на последней части
    expect(dm.slice(0, -1).every((m) => !m.markup)).toBe(true);

    // «Кому я дарю» тоже собирает весь список
    const giver = santaOfA === 1 ? org : santaOfA === 3 ? b : a;
    const before = env.sent.length;
    await giver.say("/start");
    await giver.click("Кому я дарю");
    const shown = env.sent.slice(before).filter((s) => s.chat === santaOfA).map((s) => plain(s.text)).join("\n");
    for (let i = 0; i < 20; i++) expect(shown).toContain(url(i));
    void santa;

    // после жеребьёвки правка тоже доходит целиком (несколько сообщений Санте)
    const n = env.sent.length;
    await a.say("/start");
    await a.click("Мой список");
    await a.click("1.");
    await a.click("Изменить");
    await a.say(url(99));
    const upd = env.sent.slice(n).filter((s) => s.chat === santaOfA).map((s) => plain(s.text)).join("\n");
    expect(upd).toContain(url(99));
    expect(upd).toContain(url(19));
  });

  it("лимит одного пункта — 2000 символов", async () => {
    const org = env.user(1, "Орг");
    await createGame(org);
    await org.click("Добавить подарок");
    await org.say("x".repeat(2001));
    expect(org.last()).toContain("Слишком длинно");
    await org.say("x".repeat(2000));
    expect(org.last()).toContain("Добавлено");
  });
});

describe("меню участника", () => {
  it("в меню игры нет «Создать игру»; создание — через «Мои игры»", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А");
    const code = await createGame(org);
    await a.say(`/start ${code}`);
    expect(a.hasButton("Создать игру")).toBe(false);
    expect(a.hasButton("Мои игры")).toBe(true);
    await a.click("Мои игры");
    expect(a.hasButton("Создать игру")).toBe(true);
    await a.click("Создать игру");
    expect(a.last()).toContain("назовём");
  });
});

describe("правила: подписи", () => {
  it("кнопка удаления показывает, из кого состоит правило, и разные правила различимы", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "Аня"), b = env.user(3, "Боб"), c = env.user(4, "Катя");
    const code = await createGame(org);
    for (const u of [a, b, c]) await u.say(`/start ${code}`);
    await org.click("Управление");
    await org.click("Правила");
    for (const pair of [["Аня", "Боб"], ["Боб", "Катя"]]) {
      await org.click("Добавить правило");
      for (const n of pair) await org.click(n);
      await org.click("Сохранить");
    }
    const labels = org.buttons().map((x) => x.text).filter((x) => x.startsWith("🗑"));
    expect(labels).toEqual(["🗑 1. Аня (@user2), Боб (@user3)", "🗑 2. Боб (@user3), Катя (@user4)"]);
    // удаляем второе правило — первое остаётся
    await org.click("🗑 2.");
    expect(org.last()).toContain("Аня (@user2), Боб (@user3)");
    expect(org.last()).not.toContain("Катя");
  });
});

describe("жеребьёвка: подарки у всех", () => {
  it("организатору показано, кто не добавил подарок; после добавления жеребьёвка проходит", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "Аня"), b = env.user(3, "Боб");
    const code = await createGame(org);
    for (const u of [a, b]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    await a.click("Добавить подарок");
    await a.say("книга");

    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    expect(org.last()).toContain("не все добавили подарки");
    expect(org.last()).toContain("Орг (@");
    expect(org.last()).toContain("(вы)");
    expect(org.last()).toContain("Боб");
    expect(org.last()).not.toContain("Аня");
    expect((await env.db.getGame(gid))!.status).toBe("open");

    // обойти проверку «подделанной» кнопкой нельзя
    await org.rawCallback(`mdy:${gid}`);
    expect(org.last()).toContain("не все добавили подарки");
    expect((await env.db.getGame(gid))!.status).toBe("open");
    expect((await env.db.getAssignments(gid)).size).toBe(0);

    // организатор и Боб добавили — всё проходит
    await env.db.addWish(gid, 1, "кофе");
    await env.db.addWish(gid, 3, "чай");
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("Жеребьёвка проведена");
    expect((await env.db.getGame(gid))!.status).toBe("drawn");
  });
});
