import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_TZ, MIN_TZ } from "../src/config";
import { daysWord, localNow, parseDateInput, tzLabel, weekday } from "../src/dates";
import { InvalidInput } from "../src/links";
import { REMIND_HOUR, planReminders } from "../src/reminders";

const at = (iso: string) => Date.parse(iso + "Z"); // момент в UTC
const NOW = at("2026-11-13T12:00:00"); // пятница

describe("parseDateInput", () => {
  it.each([
    ["20.12", { y: 2026, m: 12, d: 20 }],
    ["20.12.2026", { y: 2026, m: 12, d: 20 }],
    ["  20.12.2026  ", { y: 2026, m: 12, d: 20 }],
    ["20/12/26", { y: 2026, m: 12, d: 20 }],
    ["20 12", { y: 2026, m: 12, d: 20 }],
    ["2026-12-20", { y: 2026, m: 12, d: 20 }],
    ["5.1", { y: 2027, m: 1, d: 5 }], // без года и уже прошло в этом году — следующий год
    ["13.11", { y: 2026, m: 11, d: 13 }], // сегодня
    ["12.11.2026", { y: 2026, m: 11, d: 12 }], // вчера: допускается (точная проверка — после выбора пояса)
  ])("принимает %j", (input, expected) => expect(parseDateInput(input, NOW)).toEqual(expected));

  it.each([
    ["", /дату/], ["abc", /дату/], ["20.13", /не существует/], ["31.02", /не существует/], ["0.5", /не существует/],
    ["29.02.2027", /не существует/], ["32.01.2027", /не существует/], ["11.11.2026", /прошла/], ["01.01.2020", /прошла/],
    ["01.01.2030", /далеко/], ["20.12.2026.1", /дату/], ["завтра", /дату/],
  ])("отклоняет %j", (input, re) => expect(() => parseDateInput(input, NOW)).toThrow(re));

  it("високосный день принимается, обычный год — нет", () => {
    const jan2028 = at("2028-01-10T12:00:00");
    expect(parseDateInput("29.02.2028", jan2028)).toEqual({ y: 2028, m: 2, d: 29 });
    expect(parseDateInput("29.02", jan2028)).toEqual({ y: 2028, m: 2, d: 29 });
    expect(() => parseDateInput("29.02.2027", at("2027-01-10T12:00:00"))).toThrow(/не существует/);
  });

  it("ошибка — InvalidInput", () => expect(() => parseDateInput("x", NOW)).toThrow(InvalidInput));
});

describe("localNow / вспомогательные", () => {
  it("часовые пояса и смена суток", () => {
    expect(localNow(at("2026-11-13T22:30:00"), 3)).toMatchObject({ y: 2026, m: 11, d: 14, hour: 1 });
    expect(localNow(at("2026-11-13T02:00:00"), -5)).toMatchObject({ d: 12, hour: 21 });
    expect(localNow(at("2026-12-31T23:00:00"), 2)).toMatchObject({ y: 2027, m: 1, d: 1, hour: 1 });
  });
  it("день недели", () => {
    expect(weekday({ y: 2026, m: 11, d: 14 })).toBe(6); // суббота
    expect(weekday({ y: 2026, m: 11, d: 15 })).toBe(0);
  });
  it.each([[1, "1 день"], [2, "2 дня"], [5, "5 дней"], [11, "11 дней"], [21, "21 день"], [22, "22 дня"], [112, "112 дней"]])(
    "daysWord(%i)", (n, w) => expect(daysWord(n)).toBe(w));
  it("tzLabel", () => {
    expect(tzLabel(3)).toBe("UTC+3");
    expect(tzLabel(0)).toBe("UTC+0");
    expect(tzLabel(-5)).toBe("UTC−5");
  });
});

describe("planReminders: суббота до дедлайна и день до него", () => {
  // 14.11.2026 — суббота; 12:00 по UTC+3 = 09:00 UTC
  const g = (deadline: string | null, tz = 3, last: string | null = null) => ({ deadline_date: deadline, tz_offset: tz, last_reminded_day: last });
  const SAT_MORNING = at("2026-11-14T09:00:00");

  it("нет дедлайна — ничего", () => expect(planReminders(g(null), SAT_MORNING)).toBeNull());

  it("суббота утром (дедлайн далеко): напоминают участникам, организатору сводки нет", () => {
    expect(planReminders(g("2026-11-25"), SAT_MORNING)).toEqual({ today: "2026-11-14", daysLeft: 11, participants: true, organizer: false });
  });
  it("до 12:00 по местному времени — рано", () => {
    expect(planReminders(g("2026-11-25"), at("2026-11-14T08:59:00"))).toBeNull();
    expect(REMIND_HOUR).toBe(12);
  });
  it("в обычный день недели с далёким дедлайном — ничего", () => {
    expect(planReminders(g("2026-11-25"), at("2026-11-18T09:00:00"))).toBeNull(); // среда
  });
  it("за день до дедлайна — участникам и организатору, в любой день недели", () => {
    expect(planReminders(g("2026-11-25"), at("2026-11-24T10:00:00"))).toEqual({ today: "2026-11-24", daysLeft: 1, participants: true, organizer: true });
  });
  it("в день дедлайна — только сводка организатору", () => {
    expect(planReminders(g("2026-11-25"), at("2026-11-25T09:00:00"))).toEqual({ today: "2026-11-25", daysLeft: 0, participants: false, organizer: true });
  });
  it("дедлайн в субботу: в сам день участникам не напоминаем", () => {
    const p = planReminders(g("2026-11-14"), SAT_MORNING)!;
    expect(p.participants).toBe(false);
    expect(p.organizer).toBe(true);
  });
  it("суббота = день до дедлайна: одно решение с обоими флагами", () => {
    expect(planReminders(g("2026-11-15"), SAT_MORNING)).toEqual({ today: "2026-11-14", daysLeft: 1, participants: true, organizer: true });
  });
  it("после дедлайна — тишина", () => {
    expect(planReminders(g("2026-11-25"), at("2026-11-26T09:00:00"))).toBeNull();
    expect(planReminders(g("2026-11-25"), at("2026-12-05T09:00:00"))).toBeNull();
  });
  it("в этот местный день уже напоминали — не повторяем; на другой — снова", () => {
    expect(planReminders(g("2026-11-25", 3, "2026-11-14"), SAT_MORNING)).toBeNull();
    expect(planReminders(g("2026-11-25", 3, "2026-11-07"), SAT_MORNING)).not.toBeNull();
  });
  it("граница суток по часовому поясу: суббота в UTC ≠ суббота у организатора", () => {
    // UTC+3: пятница 21:30 UTC уже суббота 00:30 — но рано (до 12:00)
    expect(planReminders(g("2026-11-25"), at("2026-11-13T21:30:00"))).toBeNull();
    // UTC−5: суббота 03:00 UTC — у организатора ещё пятница 22:00 → не суббота
    expect(planReminders(g("2026-11-25", -5), at("2026-11-14T03:00:00"))).toBeNull();
    // UTC−5: суббота 17:00 UTC = суббота 12:00 у организатора → напоминаем
    expect(planReminders(g("2026-11-25", -5), at("2026-11-14T17:00:00"))).toMatchObject({ today: "2026-11-14", participants: true });
    // UTC+10: пятница 23:00 UTC = суббота 09:00 → ещё рано; суббота 02:00 UTC = 12:00 → можно
    expect(planReminders(g("2026-11-25", 10), at("2026-11-13T23:00:00"))).toBeNull();
    expect(planReminders(g("2026-11-25", 10), at("2026-11-14T02:00:00"))).toMatchObject({ today: "2026-11-14", participants: true });
  });
  it("переход через год", () => {
    expect(planReminders(g("2027-01-01"), at("2026-12-31T09:00:00"))).toMatchObject({ daysLeft: 1, participants: true, organizer: true });
  });
  it("високосный день", () => {
    expect(planReminders(g("2028-03-01"), at("2028-02-29T09:00:00"))).toMatchObject({ daysLeft: 1 });
  });
});

describe("расписание cron покрывает все поддерживаемые часовые пояса", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const cron = /crons\s*=\s*\["([^"]+)"\]/.exec(toml)![1];
  const [minute, hourField] = cron.split(" ");
  const hours = new Set(
    hourField.split(",").flatMap((part) => {
      const [a, b] = part.split("-").map(Number);
      return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
    }),
  );

  it("запуск в начале часа", () => expect(minute).toBe("0"));
  it("для каждого пояса есть запуск ровно в 12:00 по местному времени", () => {
    for (let tz = MIN_TZ; tz <= MAX_TZ; tz++) {
      const utcHour = (REMIND_HOUR - tz + 24) % 24;
      expect(hours.has(utcHour), `UTC${tz >= 0 ? "+" : ""}${tz}: нужен запуск в ${utcHour}:00 UTC`).toBe(true);
    }
  });
  it("лишних запусков нет: каждый час — это нужный запуск или повтор не позже чем через 2 часа после нужного", () => {
    const needed = Array.from({ length: MAX_TZ - MIN_TZ + 1 }, (_, i) => (REMIND_HOUR - (MIN_TZ + i) + 24) % 24);
    for (const h of hours) expect(needed.some((n) => (h - n + 24) % 24 <= 2), `${h}:00 UTC лишний`).toBe(true);
    expect(hours.size).toBeLessThanOrEqual(needed.length + 2);
  });
  it("если рассылка в 12:00 не удалась, до конца того же местного дня есть ещё запуск (повтор)", () => {
    for (let tz = MIN_TZ; tz <= MAX_TZ; tz++) {
      const first = (REMIND_HOUR - tz + 24) % 24; // час UTC, когда у организатора 12:00
      // следующий запуск через 1…13 часов — это ещё тот же местный день (до 23:00)
      const retries = [...hours].filter((h) => {
        const delta = (h - first + 24) % 24;
        return delta >= 1 && delta <= 23 - REMIND_HOUR;
      });
      expect(retries.length, `UTC+${tz}`).toBeGreaterThan(0);
    }
  });
});
