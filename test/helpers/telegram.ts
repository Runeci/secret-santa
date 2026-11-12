import { Bot } from "grammy";
import { Database } from "../../src/db";
import { registerHandlers } from "../../src/bot";
import type { Markup } from "../../src/keyboards";
import { deliver, type Outbox } from "../../src/outbox";
import { createD1 } from "./d1";

export const BOT_USERNAME = "santa_test_bot";

export function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface Sent {
  chat: number;
  text: string;
  markup?: Markup;
  edit: boolean;
}

export class Env {
  sent: Sent[] = [];
  alerts: string[] = [];
  blocked = new Set<number>();
  db = new Database(createD1());
  bot: Bot;
  private mid = 0;
  private uid = 0;

  constructor() {
    this.bot = new Bot("123456:TEST", {
      botInfo: {
        id: 1, is_bot: true, first_name: "Santa", username: BOT_USERNAME,
        can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false,
      } as any,
    });
    this.bot.api.config.use(async (_prev, method, payload: any) => {
      if (method === "answerCallbackQuery") {
        if (payload.show_alert && payload.text) this.alerts.push(payload.text);
        return { ok: true, result: true } as any;
      }
      if (method === "sendMessage" || method === "editMessageText") {
        const chat = Number(payload.chat_id);
        if (method === "sendMessage" && this.blocked.has(chat)) {
          return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } as any;
        }
        this.sent.push({ chat, text: payload.text, markup: payload.reply_markup, edit: method === "editMessageText" });
        return {
          ok: true,
          result: { message_id: ++this.mid, date: 0, chat: { id: chat, type: "private" }, text: payload.text },
        } as any;
      }
      throw new Error("unexpected API method " + method);
    });
    // Очередь в тестах: доставляем сразу тем же кодом, что и потребитель очереди.
    const outbox: Outbox = {
      send: async (msgs) => {
        for (const m of msgs) await deliver(this.bot.api, m);
      },
    };
    registerHandlers(this.bot, this.db, outbox);
  }

  nextId() {
    return ++this.uid;
  }
  user(id: number, name: string) {
    return new Client(this, id, name);
  }
}

export class Client {
  private seq = 0;
  constructor(public env: Env, public uid: number, public name: string) {}

  private from() {
    return { id: this.uid, is_bot: false, first_name: this.name, username: `user${this.uid}` };
  }
  private chat() {
    return { id: this.uid, type: "private" as const };
  }

  async say(text: string) {
    const entities = text.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }]
      : undefined;
    await this.env.bot.handleUpdate({
      update_id: this.env.nextId(),
      message: { message_id: ++this.seq, date: 0, chat: this.chat(), from: this.from(), text, entities },
    } as any);
  }

  lastMarkup(): Markup {
    for (let i = this.env.sent.length - 1; i >= 0; i--) {
      const s = this.env.sent[i];
      if (s.chat === this.uid && s.markup) return s.markup;
    }
    throw new Error("нет клавиатуры");
  }
  buttons() {
    return this.lastMarkup().inline_keyboard.flat();
  }
  hasButton(label: string) {
    return this.buttons().some((b) => b.text.includes(label));
  }

  private async callback(data: string) {
    await this.env.bot.handleUpdate({
      update_id: this.env.nextId(),
      callback_query: {
        id: String(this.env.nextId()), from: this.from(), chat_instance: "x", data,
        message: { message_id: 1, date: 0, chat: this.chat() },
      },
    } as any);
  }
  async click(label: string) {
    const b = this.buttons().find((x) => x.text.includes(label));
    if (!b) throw new Error(`нет кнопки «${label}»; есть: ${this.buttons().map((x) => x.text).join(" | ")}`);
    await this.callback(b.callback_data);
  }
  async rawCallback(data: string) {
    await this.callback(data);
  }

  inbox(): string[] {
    return this.env.sent.filter((s) => s.chat === this.uid).map((s) => plain(s.text));
  }
  last(): string {
    return this.inbox().at(-1)!;
  }
}
