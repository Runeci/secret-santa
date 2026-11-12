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

/** Лимиты Cloudflare Queues: до 100 сообщений и до 256 КБ в одной пачке (берём запас). */
const BATCH_MESSAGES = 100;
const BATCH_BYTES = 200_000;

export function queueOutbox(queue: { sendBatch(m: { body: OutMsg }[]): Promise<unknown> }): Outbox {
  const enc = new TextEncoder();
  return {
    async send(messages) {
      let batch: { body: OutMsg }[] = [];
      let bytes = 0;
      const flush = async () => {
        if (batch.length) await queue.sendBatch(batch);
        batch = [];
        bytes = 0;
      };
      for (const body of messages) {
        const size = enc.encode(JSON.stringify(body)).length + 64;
        if (batch.length >= BATCH_MESSAGES || (batch.length && bytes + size > BATCH_BYTES)) await flush();
        batch.push({ body });
        bytes += size;
      }
      await flush();
    },
  };
}
