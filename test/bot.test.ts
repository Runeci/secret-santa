import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_USERNAME, Client, Env, plain } from "./helpers/telegram";

let env: Env;

/** Всем участникам игры добавляет подарок (если пусто) и отмечает список готовым: жеребьёвка этого требует. */
async function wishAll(code: string) {
  const gid = (await env.db.getGameByCode(code))!.id;
  for (const p of await env.db.getPlayers(gid)) {
    if (!(await env.db.getWishes(gid, p.user_id)).length) await env.db.addWish(gid, p.user_id, "подарок");
    await env.db.setReady(gid, p.user_id, true);
  }
}

beforeEach(() => {
  env = new Env();
  // боевой обработчик ошибок пишет в console.error — ловим это, чтобы ошибки не «глотались» незаметно
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void env.errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(env.errors).toEqual([]); // в обычных тестах ни одна ошибка обработчика не допускается
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
    await ann.click("📝 Мой список");
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
    await ann.click("📝 Мой список");
    await ann.click("Шоколад");
    await ann.click("Удалить");
    expect(santaOfAnn.inbox().slice(n).some((m) => m.includes("обновил") && !m.includes("Шоколад"))).toBe(true);

    // правка у Боба уведомляет его Санту
    const santaOfBob = users[(await env.db.getGiver(gid, 3))!];
    n = santaOfBob.inbox().length;
    await bob.say("/start");
    await bob.click("📝 Мой список");
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
    expect(a.buttons().filter((b) => b.text.startsWith("🎄")).length).toBe(2); // Аня — только участник
    expect(a.last()).not.toContain("вы организатор");
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
    await a.click("📝 Мой список");
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
    await a.click("📝 Мой список");
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

describe("кнопка «Мой список готов»", () => {
  it("без готовности всех жеребьёвка не идёт; организатор видит прогресс и причины", async () => {
    const org = env.user(1, "Орг"), ann = env.user(2, "Аня"), bob = env.user(3, "Боб");
    const code = await createGame(org);
    for (const u of [ann, bob]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    expect(ann.last()).toContain("Ваш список: ещё не готов");

    // в меню игры кнопки готовности нет: она только на экране «Мой список»
    expect(ann.hasButton("Мой список готов")).toBe(false);
    await ann.click("📝 Мой список");
    expect(ann.hasButton("Мой список готов")).toBe(true);

    // с пустым списком отметить нельзя
    await ann.click("Мой список готов");
    expect(env.alerts.at(-1)).toContain("хотя бы один подарок");

    // подарок добавлен; в сообщении «Добавлено» кнопки готовности тоже нет, она на экране списка
    await ann.click("Добавить подарок");
    await ann.say("книга");
    expect(ann.hasButton("Мой список готов")).toBe(false);
    await ann.click("📝 Мой список");
    await ann.click("Мой список готов");
    expect(ann.last()).toContain("Список: готов ✅"); // остались на экране списка
    expect(ann.hasButton("Вернуть список в работу")).toBe(true);
    expect(org.inbox().some((m) => m.includes("Аня") && m.includes("отметил(а) список готовым") && m.includes("Готовы: 1 из 3"))).toBe(true);

    // организатор: прогресс и отказ с причинами
    await org.click("Управление");
    expect(org.last()).toContain("Списки готовы: 1 из 3");
    await org.click("Провести жеребьёвку");
    expect(org.last()).toContain("не все списки готовы");
    expect(org.last()).toMatch(/Орг \(@user1\) \(вы\) — нет подарков/);
    expect(org.last()).toMatch(/Боб \(@user3\) — нет подарков/);
    expect(org.last()).not.toContain("Аня");
    await org.rawCallback(`mdy:${gid}`); // обойти кнопкой нельзя
    expect(org.last()).toContain("не все списки готовы");
    expect((await env.db.getGame(gid))!.status).toBe("open");

    // у Боба есть подарок, но он не нажал «готов» -> причина другая
    await bob.click("Добавить подарок");
    await bob.say("чай");
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    expect(org.last()).toMatch(/Боб \(@user3\) — не отметил\(а\) список готовым/);

    await bob.click("📝 Мой список");
    await bob.click("Мой список готов");
    expect(org.inbox().some((m) => m.includes("Готовы: 2 из 3"))).toBe(true);

    // последним готов становится организатор: ему приходит «можно проводить»
    await org.say("/start");
    await org.click("Добавить подарок");
    await org.say("кофе");
    await org.click("📝 Мой список");
    await org.click("Мой список готов");
    expect(org.inbox().some((m) => m.includes("Все списки готовы") && m.includes("3 из 3"))).toBe(true);

    await org.click("В меню игры"); // организатор остался на экране своего списка
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("Жеребьёвка проведена");
    expect((await env.db.getGame(gid))!.status).toBe("drawn");

    // после жеребьёвки кнопки готовности нет и на экране списка
    await ann.say("/start");
    await ann.click("📝 Мой список");
    expect(ann.hasButton("Мой список готов")).toBe(false);
    expect(ann.hasButton("Вернуть список в работу")).toBe(false);
    await ann.click("В меню игры");
    expect(ann.last()).not.toContain("Ваш список:");
  });

  it("удалил последний подарок — отметка остаётся как поставил участник, жеребьёвка заблокирована; вернуть в работу можно", async () => {
    const org = env.user(1, "Орг"), ann = env.user(2, "Аня"), bob = env.user(3, "Боб");
    const code = await createGame(org);
    for (const u of [ann, bob]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    await wishAll(code);

    await ann.say("/start");
    expect(ann.last()).toContain("Ваш список: готов ✅");
    await ann.click("📝 Мой список");
    await ann.click("1.");
    await ann.click("Удалить");
    expect(ann.last()).toContain("Список: готов ✅"); // сама не сбросилась (мы остались на экране списка)
    expect(ann.hasButton("Вернуть список в работу")).toBe(true); // и вернуть в работу можно
    await ann.click("В меню игры");
    expect(ann.last()).toContain("Ваш список: готов ✅");
    expect(ann.last()).toContain("подарков в нём нет");
    await ann.click("📝 Мой список");

    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    expect(org.last()).toMatch(/Аня.*— нет подарков/);
    expect((await env.db.getGame(gid))!.status).toBe("open");

    await ann.click("Вернуть список в работу");
    expect(ann.last()).toContain("Список: ещё не готов");

    await bob.say("/start");
    await bob.click("📝 Мой список");
    await bob.click("Вернуть список в работу");
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    expect(org.last()).toMatch(/Боб.*— не отметил\(а\) список готовым/);
  });
});

describe("граничные случаи (ревью)", () => {
  async function drawnGame() {
    const org = env.user(1, "Орг"), a = env.user(2, "А"), b = env.user(3, "Б");
    const code = await createGame(org);
    for (const u of [a, b]) await u.say(`/start ${code}`);
    await wishAll(code);
    const gid = (await env.db.getGameByCode(code))!.id;
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    return { org, a, b, code, gid };
  }

  it("в группе бот ничего не раскрывает: ни меню, ни пару", async () => {
    const { a, gid } = await drawnGame();
    const before = env.sent.length;
    await a.sayInGroup("/start");
    await a.callbackInGroup(`to:${gid}`);
    await a.callbackInGroup(`g:${gid}`);
    const leaked = env.sent.slice(before).filter((s) => s.chat === -1001 || /Санта для/.test(plain(s.text)));
    expect(leaked.every((s) => !/Санта для|Ваши игры|Управление/.test(plain(s.text)))).toBe(true);
    expect(env.sent.slice(before).some((s) => s.edit)).toBe(false); // ничего не редактировалось в группе
    expect(env.alerts.at(-1)).toContain("личных сообщениях");
  });

  it("сбой рассылки после жеребьёвки: организатор узнаёт, игра сохранена, пару можно узнать кнопкой", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А"), b = env.user(3, "Б");
    const code = await createGame(org);
    for (const u of [a, b]) await u.say(`/start ${code}`);
    await wishAll(code);
    env.outbox.send = async () => {
      throw new Error("queue down");
    };
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    expect(org.last()).toContain("рассылку личных сообщений отправить не удалось");
    env.errors.length = 0; // сбой очереди залогирован — это ожидаемо в этом тесте
    expect((await env.db.getGame((await env.db.getGameByCode(code))!.id))!.status).toBe("drawn");
    await a.say("/start");
    await a.click("Кому я дарю");
    expect(a.last()).toContain("Тайный Санта для");
  });

  it("при необработанной ошибке пользователь видит сообщение, а не тишину", async () => {
    const u = env.user(5, "Z");
    const orig = env.db.gamesOfUser.bind(env.db);
    env.db.gamesOfUser = async () => {
      throw new Error("D1 unavailable");
    };
    await u.say("/start");
    env.db.gamesOfUser = orig;
    expect(u.last()).toContain("Что-то пошло не так");
    expect(env.errors.length).toBe(1);
    env.errors.length = 0; // ошибка ожидаема в этом тесте
  });

  it("совпадающее правило называет номер существующего", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А");
    const code = await createGame(org);
    await a.say(`/start ${code}`);
    await org.click("Управление");
    await org.click("Правила");
    for (let i = 0; i < 2; i++) {
      await org.click("Добавить правило");
      await org.click("Орг");
      await org.click("А");
      await org.click("Сохранить");
    }
    expect(env.alerts.at(-1)).toContain("№1");
  });

  it("экраны с 50 участниками и очень длинными именами укладываются в лимит Telegram и показывают всех", async () => {
    const org = env.user(1, "Орг");
    const code = await createGame(org);
    const gid = (await env.db.getGameByCode(code))!.id;
    for (let i = 2; i <= 50; i++) await env.db.addPlayer(gid, i, `Игрок${i}` + "я".repeat(120) + ` (@u${i})`);
    const all = Array.from({ length: 50 }, (_, i) => i + 1);
    await env.db.addRule(gid, all); // одно огромное правило
    for (let i = 0; i < 20; i++) await env.db.addRule(gid, [i + 2, i + 3, i + 4]);
    const shown = (from: number) =>
      env.sent.slice(from).filter((s) => s.chat === 1).map((s) => plain(s.text)).join("\n");

    let n = env.sent.length;
    await org.click("Управление");
    await org.click("Участники");
    for (let i = 2; i <= 50; i++) expect(shown(n)).toContain(`Игрок${i}я`);

    await org.click("Управление");
    n = env.sent.length;
    await org.click("Правила");
    expect(shown(n)).toContain("Игрок50я"); // огромное правило показано целиком, пусть и в нескольких сообщениях

    await org.click("Управление");
    n = env.sent.length;
    await org.click("Провести жеребьёвку"); // ни у кого нет подарков -> длинный список «кто не добавил»
    expect(shown(n)).toContain("не все списки готовы");
    for (let i = 2; i <= 50; i++) expect(shown(n)).toContain(`Игрок${i}я`);
    expect(org.hasButton("Управление")).toBe(true); // клавиатура на последнем сообщении
  });
});

describe("список участников у организатора", () => {
  it("видно, у кого сколько подарков и готов ли список", async () => {
    const org = env.user(1, "Орг"), ann = env.user(2, "Аня"), bob = env.user(3, "Боб");
    const code = await createGame(org);
    for (const u of [ann, bob]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    for (const t of ["книга", "носки"]) await env.db.addWish(gid, 2, t);
    await env.db.setReady(gid, 2, true);
    await env.db.addWish(gid, 1, "кофе"); // у организатора подарок есть, но не готов

    await org.click("Управление");
    await org.click("Участники");
    const text = org.last();
    expect(text).toMatch(/1\. Орг \(@user1\) 👑 — 1 подарок ⏳/);
    expect(text).toMatch(/2\. Аня \(@user2\) — 2 подарка ✅/);
    expect(text).toMatch(/3\. Боб \(@user3\) — нет подарков ⏳/);
    expect(text).toContain("✅ — список готов");
  });

  it("после жеребьёвки показываются подарки без отметок готовности", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "А"), b = env.user(3, "Б");
    const code = await createGame(org);
    for (const u of [a, b]) await u.say(`/start ${code}`);
    await wishAll(code);
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    await org.click("Управление");
    await org.click("Участники");
    expect(org.last()).toMatch(/А \(@user2\) — 1 подарок$/m);
    expect(org.last()).not.toMatch(/[✅⏳] *$/m);
  });
});

describe("приглашение участником", () => {
  it("участник получает ссылку отдельным сообщением; по ней можно вступить; после жеребьёвки кнопки нет", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "Аня");
    const code = await createGame(org);
    await a.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    expect(a.hasButton("Пригласить участников")).toBe(true);

    await a.click("Пригласить участников");
    const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
    const mine = env.sent.filter((s) => s.chat === 2).map((s) => s.text);
    expect(plain(mine.at(-1)!)).toContain(link); // ссылка — в отдельном сообщении для пересылки
    expect(plain(mine.at(-1)!)).toContain("Приглашаю в игру");
    // пересылаемое сообщение не содержит служебных слов для организатора
    expect(plain(mine.at(-1)!)).not.toMatch(/организатор|жеребьёвк|Управление|Ваш список/i);
    expect(mine.at(-2)).toContain("Перешлите");

    const friend = env.user(7, "Друг");
    await friend.say(`/start ${code}`); // тот, кто пришёл по ссылке участника
    expect(await env.db.isPlayer(gid, 7)).toBe(true);
    expect(org.inbox().some((m) => m.includes("Новый участник") && m.includes("Друг"))).toBe(true);

    await wishAll(code);
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    await a.say("/start");
    expect(a.hasButton("Пригласить участников")).toBe(false);
    await a.rawCallback(`il:${gid}`);
    expect(env.alerts.at(-1)).toContain("поздно");
    await env.user(8, "Чужой").rawCallback(`il:${gid}`);
    expect(env.alerts.at(-1)).toContain("не участвуете");
  });
});

describe("ссылка и стоимость подарка в боте", () => {
  it("добавление, проверка ввода, отмена, редактирование и удаление; Санта видит всё", async () => {
    const org = env.user(1, "Орг"), ann = env.user(2, "Аня"), bob = env.user(3, "Боб");
    const code = await createGame(org);
    for (const u of [ann, bob]) await u.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;

    await ann.click("Добавить подарок");
    await ann.say("Книга «Дюна»");
    // сразу под сообщением «Добавлено» можно добавить ссылку и цену (необязательно)
    expect(ann.hasButton("Добавить ссылку") && ann.hasButton("Добавить цену")).toBe(true);

    await ann.click("Добавить ссылку");
    await ann.say("купить книгу"); // не ссылка
    expect(ann.last()).toContain("не похоже на ссылку");
    await ann.say("ftp://example.com/x"); // состояние сохранилось, снова не ссылка
    expect(ann.last()).toContain("http");
    await ann.say("www.ozon.ru/product/dune?a=1&b=2");
    expect(ann.last()).toContain("Ссылка сохранена");
    expect(ann.last()).toContain("🔗 https://www.ozon.ru/product/dune?a=1&b=2");
    expect(ann.hasButton("Изменить ссылку") && ann.hasButton("Убрать ссылку")).toBe(true);

    await ann.click("Добавить цену");
    await ann.say("дорого"); // нет цифр
    expect(ann.last()).toContain("хотя бы одна цифра");
    await ann.say("около 1 500 ₽");
    expect(ann.last()).toContain("Стоимость сохранена");
    expect(ann.last()).toContain("💰 около 1 500 ₽");

    // отмена из ввода возвращает на карточку подарка
    await ann.click("Изменить цену");
    await ann.click("Отмена");
    expect(ann.last()).toContain("Книга «Дюна»");
    expect(ann.last()).toContain("🔗");

    // в списке — коротко: цена и значок ссылки
    await ann.click("К списку");
    expect(ann.last()).toContain("1. Книга «Дюна» — около 1 500 ₽ 🔗");

    // при жеребьёвке Санта получает подарок целиком: цена и полная ссылка
    await wishAll(code);
    await org.click("Управление");
    await org.click("Провести жеребьёвку");
    await org.click("Запустить");
    const santa = (await env.db.getGiver(gid, 2))!;
    const dm = env.sent.filter((s) => s.chat === santa && /Санта для/.test(plain(s.text))).map((s) => plain(s.text)).join("\n");
    expect(dm).toContain("1. Книга «Дюна» — около 1 500 ₽");
    expect(dm).toContain("🔗 https://www.ozon.ru/product/dune?a=1&b=2");

    // после жеребьёвки правка ссылки уведомляет Санту; убрать ссылку тоже
    let n = env.sent.length;
    await ann.say("/start");
    await ann.click("📝 Мой список");
    await ann.click("1.");
    await ann.click("Изменить ссылку");
    await ann.say("https://market.yandex.ru/product/777");
    let note = env.sent.slice(n).filter((s) => s.chat === santa).map((s) => plain(s.text)).join("\n");
    expect(note).toContain("обновил");
    expect(note).toContain("https://market.yandex.ru/product/777");

    n = env.sent.length;
    await ann.click("Убрать ссылку");
    note = env.sent.slice(n).filter((s) => s.chat === santa).map((s) => plain(s.text)).join("\n");
    expect(note).toContain("обновил");
    expect(note).not.toContain("🔗");
    expect(ann.hasButton("Убрать ссылку")).toBe(false);
    expect(ann.hasButton("Добавить ссылку")).toBe(true);
    await ann.click("Убрать цену");
    expect(ann.last()).not.toContain("💰");
  });

  it("чужие кнопки ссылки/цены не работают", async () => {
    const org = env.user(1, "Орг"), ann = env.user(2, "Аня");
    const code = await createGame(org);
    await ann.say(`/start ${code}`);
    const gid = (await env.db.getGameByCode(code))!.id;
    const wid = await env.db.addWish(gid, 2, "книга");
    for (const data of [`wl:${gid}:${wid}`, `wp:${gid}:${wid}`, `wlx:${gid}:${wid}`, `wpx:${gid}:${wid}`]) {
      env.alerts.length = 0;
      await org.rawCallback(data);
      expect(env.alerts.at(-1), data).toContain("Такого пункта");
    }
  });

  it("слишком длинная ссылка отклоняется, длинная допустимая принимается", async () => {
    const org = env.user(1, "Орг");
    await createGame(org);
    await org.click("Добавить подарок");
    await org.say("штука");
    await org.click("Добавить ссылку");
    await org.say("https://shop.example/" + "a".repeat(1600));
    expect(org.last()).toContain("Слишком длинная ссылка");
    await org.say("https://shop.example/" + "a".repeat(1400));
    expect(org.last()).toContain("Ссылка сохранена");
  });
});

describe("приглашение: игрок не видит служебных текстов организатора", () => {
  it("вступивший по ссылке не видит «вы организатор»; пересылаемое приглашение нейтральное", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "Аня");
    await org.say("/new");
    await org.say("Новый год");
    // при создании игры ссылка приходит отдельным сообщением-приглашением
    const invites = env.sent.filter((s) => s.chat === 1).map((s) => plain(s.text)).filter((m) => m.includes("start="));
    expect(invites.length).toBe(1);
    expect(invites[0]).toContain("Приглашаю в игру");
    expect(invites[0]).not.toMatch(/организатор|жеребьёвк|Управление|Ваш список/i);
    const code = /start=(\S+)/.exec(invites[0])![1];

    await a.say(`/start ${code}`);
    expect(a.inbox().join("\n")).not.toMatch(/организатор|Управление/i);
    expect(org.inbox().join("\n")).toContain("Вы — организатор"); // а у организатора — есть
    expect(a.inbox().join("\n")).toContain("Вы — участник");
    expect(org.inbox().join("\n")).toContain("👑 Новый год");
  });
});

describe("«Мои игры»: пометка организатора", () => {
  it("👑 у игр, где я организатор, 🎄 — где участник", async () => {
    const x = env.user(1, "Икс"), y = env.user(2, "Игрек");
    const mine = await createGame(x, "Моя игра");
    const theirs = await createGame(y, "Чужая игра");
    await x.say(`/start ${theirs}`); // Икс — организатор «Моей» и участник «Чужой»
    await x.say("/start");
    const labels = x.buttons().map((b) => b.text).filter((t) => /игра/.test(t));
    expect(labels).toEqual(["👑 Моя игра", "🎄 Чужая игра"]);
    expect(x.last()).toContain("👑 — вы организатор, 🎄 — вы участник");
    void mine;
  });
});

describe("роль в меню игры", () => {
  it("организатор сразу видит «Вы — организатор», участник — «Вы — участник»; и в «Управлении»", async () => {
    const org = env.user(1, "Орг"), a = env.user(2, "Аня");
    const code = await createGame(org, "Офис");
    await a.say(`/start ${code}`);
    await org.say("/start");
    expect(org.last()).toContain("👑 Офис");
    expect(org.last()).toContain("Вы — организатор");
    expect(a.last()).toContain("🎄 Офис");
    expect(a.last()).toContain("Вы — участник");
    expect(a.last()).not.toContain("организатор");
    await org.click("Управление");
    expect(org.last()).toContain("Вы — организатор");
  });
});
