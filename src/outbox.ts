import { GrammyError, type Api } from "grammy";
import type { Markup } from "./keyboards";

/** Сообщение для отправки через очередь (рассылка пар: бесплатный план ограничивает 50 запросов на вызов). */
export interface OutMsg {
  chat: number;
  text: string;
  markup?: Markup;
  /** Кого и о чём уведомить, если доставить не удалось (бот заблокирован и т. п.). */
  failNotify?: { chat: number; text: string };
}

export interface Outbox {
  send(messages: OutMsg[]): Promise<void>;
}

export type DeliverResult = { ok: true } | { ok: false; retryAfter: number };

export async function deliver(api: Api, m: OutMsg): Promise<DeliverResult> {
  try {
    await api.sendMessage(m.chat, m.text, { parse_mode: "HTML", reply_markup: m.markup });
    return { ok: true };
  } catch (err) {
    if (!(err instanceof GrammyError)) throw err; // сетевые сбои — пусть очередь повторит
    if (err.error_code === 429) return { ok: false, retryAfter: err.parameters?.retry_after ?? 1 };
    if (m.failNotify) {
      try {
        await api.sendMessage(m.failNotify.chat, m.failNotify.text, { parse_mode: "HTML" });
      } catch {
        /* организатор тоже недоступен — ничего не поделать */
      }
    }
    return { ok: true }; // окончательная ошибка (403/400): повторять бессмысленно
  }
}

export function queueOutbox(queue: { sendBatch(m: { body: OutMsg }[]): Promise<unknown> }): Outbox {
  return {
    async send(messages) {
      for (let i = 0; i < messages.length; i += 100) {
        await queue.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })));
      }
    },
  };
}
