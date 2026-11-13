/** Напоминания о дедлайне. planReminders — чистое решение «что слать сегодня», runReminders — рассылка. */
import { dayNumber, localNow, parseYMD, weekday, ymdToString } from "./dates";
import type { Database, Game } from "./db";
import { isReady } from "./db";
import * as kb from "./keyboards";
import type { OutMsg, Outbox } from "./outbox";
import * as t from "./texts";

/** Напоминания приходят утром по местному времени организатора. */
export const REMIND_HOUR = 10;

export interface ReminderPlan {
  today: string; // местный день (YYYY-MM-DD) — отметка «уже напомнили»
  daysLeft: number; // 0 — сегодня последний день
  participants: boolean; // напомнить не готовым участникам
  organizer: boolean; // прислать организатору сводку
}

/**
 * Правила: участникам, чей список не готов, — по субботам до дедлайна и за день до него;
 * организатору — сводка за день до дедлайна и в день дедлайна. Не чаще раза в местные сутки.
 */
export function planReminders(
  g: Pick<Game, "deadline_date" | "tz_offset" | "last_reminded_day">,
  nowMs: number,
): ReminderPlan | null {
  if (!g.deadline_date) return null;
  const now = localNow(nowMs, g.tz_offset);
  if (now.hour < REMIND_HOUR) return null;
  const today = ymdToString(now);
  if (g.last_reminded_day === today) return null;
  const daysLeft = dayNumber(parseYMD(g.deadline_date)) - dayNumber(now);
  if (daysLeft < 0) return null; // дедлайн прошёл
  const participants = (weekday(now) === 6 && daysLeft > 0) || daysLeft === 1;
  const organizer = daysLeft <= 1;
  if (!participants && !organizer) return null;
  return { today, daysLeft, participants, organizer };
}

/** Проходит по открытым играм с дедлайном и рассылает напоминания через очередь. */
export async function runReminders(db: Database, outbox: Outbox, nowMs = Date.now()): Promise<number> {
  let sent = 0;
  for (const game of await db.gamesWithDeadline()) {
    const plan = planReminders(game, nowMs);
    if (!plan) continue;
    const notReady = (await db.getReadiness(game.id)).filter((p) => !isReady(p));
    const messages: OutMsg[] = [];
    if (plan.participants) {
      for (const p of notReady)
        messages.push({ chat: p.user_id, text: t.deadlineReminder(game.title, game.deadline_date!, plan.daysLeft), markup: kb.openGame(game.id) });
    }
    if (plan.organizer && notReady.length) {
      t.deadlineSummaryParts(game.title, plan.daysLeft, notReady).forEach((text, i, parts) =>
        messages.push({ chat: game.organizer_id, text, markup: i === parts.length - 1 ? kb.openGame(game.id) : undefined }),
      );
    }
    if (messages.length) await outbox.send(messages);
    await db.setLastReminded(game.id, plan.today); // отметка после успешной отправки: при сбое повторим в следующий запуск
    sent += messages.length;
  }
  return sent;
}
