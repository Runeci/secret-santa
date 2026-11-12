import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { registerHandlers } from "./bot";
import { Database, type D1Like } from "./db";
import { deliver, queueOutbox, type OutMsg } from "./outbox";

interface Env {
  DB: D1Database;
  OUTBOX: Queue<OutMsg>;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Только для локальной проверки: адрес поддельного Telegram API. */
  TELEGRAM_API_ROOT?: string;
}

// Информация о боте (getMe) кешируется в изоляте, чтобы не тратить лишний запрос на каждый вызов.
let botInfo: UserFromGetMe | undefined;

const apiOptions = (env: Env) => (env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : undefined);

async function makeBot(env: Env): Promise<Bot> {
  const bot = new Bot(env.BOT_TOKEN, { botInfo, client: apiOptions(env) });
  if (!botInfo) {
    await bot.init();
    botInfo = bot.botInfo;
  }
  registerHandlers(bot, new Database(env.DB as unknown as D1Like), queueOutbox(env.OUTBOX));
  return bot;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      const bot = await makeBot(env);
      return webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET })(request);
    }
    return new Response("Secret Santa bot is running", { status: 200 });
  },

  /** Рассылка личных сообщений из очереди: по 10 за вызов, с повтором при лимитах Telegram. */
  async queue(batch: MessageBatch<OutMsg>, env: Env): Promise<void> {
    const bot = new Bot(env.BOT_TOKEN, { botInfo, client: apiOptions(env) });
    for (const msg of batch.messages) {
      try {
        const res = await deliver(bot.api, msg.body);
        if (res.ok) msg.ack();
        else msg.retry({ delaySeconds: res.retryAfter });
      } catch {
        msg.retry({ delaySeconds: 5 });
      }
    }
  },
};
