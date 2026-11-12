import { describe, expect, it } from "vitest";
import { type OutMsg, queueOutbox } from "../src/outbox";

describe("queueOutbox: пачки укладываются в лимиты Cloudflare Queues", () => {
  const enc = new TextEncoder();
  const msg = (i: number): OutMsg => ({ chat: i, text: `${i}: ` + "я".repeat(3800), markup: { inline_keyboard: [[{ text: "x", callback_data: "g:1" }]] } });

  it("не больше 100 сообщений и 256 КБ в пачке, порядок и состав сохраняются", async () => {
    const batches: { body: OutMsg }[][] = [];
    const outbox = queueOutbox({ sendBatch: async (b) => void batches.push(b) });
    const all = Array.from({ length: 150 }, (_, i) => msg(i)); // 150 сообщений по ~7,6 КБ ≈ 1,1 МБ
    await outbox.send(all);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(100);
      const bytes = enc.encode(JSON.stringify(b)).length;
      expect(bytes).toBeLessThanOrEqual(256 * 1024);
    }
    expect(batches.flat().map((m) => m.body.chat)).toEqual(all.map((m) => m.chat));
  });

  it("пустой список не вызывает очередь; одно большое сообщение уходит отдельно", async () => {
    let calls = 0;
    const outbox = queueOutbox({ sendBatch: async () => void calls++ });
    await outbox.send([]);
    expect(calls).toBe(0);
    await outbox.send([msg(1)]);
    expect(calls).toBe(1);
  });
});
