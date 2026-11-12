// Локальная проверка в настоящем runtime Workers (workerd): локальная D1 + очередь + webhook,
// Telegram подменён фейковым сервером. Запуск: node scripts/smoke.mjs
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";

const TG_PORT = 8799, WORKER_PORT = 8788, SECRET = "smoke-secret";
const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", WRANGLER_SEND_METRICS: "false", CI: "1" };
delete env.HTTPS_PROXY; delete env.HTTP_PROXY; delete env.https_proxy; delete env.http_proxy;

const log = [];
let mid = 0;
const tg = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    const p = body ? JSON.parse(body) : {};
    log.push({ method, ...p });
    let result = true;
    if (method === "getMe") result = { id: 1, is_bot: true, first_name: "Santa", username: "smoke_bot" };
    else if (method === "sendMessage" || method === "editMessageText")
      result = { message_id: ++mid, date: 0, chat: { id: p.chat_id, type: "private" }, text: p.text };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(TG_PORT, "127.0.0.1");

const sh = (args) => execFileSync("npx", ["wrangler", ...args], { env, stdio: "pipe" }).toString();
sh(["d1", "migrations", "apply", "secret-santa", "--local"]);

const worker = spawn("npx", ["wrangler", "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1",
  "--var", "BOT_TOKEN:123:SMOKE", "--var", `WEBHOOK_SECRET:${SECRET}`, "--var", `TELEGRAM_API_ROOT:http://127.0.0.1:${TG_PORT}`],
  { env, stdio: ["ignore", "pipe", "pipe"], detached: true }); // своя группа процессов: убиваем целиком
let wlog = "";
worker.stdout.on("data", (d) => (wlog += d));
worker.stderr.on("data", (d) => (wlog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error("FAIL:", msg, "\n--- worker log ---\n" + wlog.slice(-2500)); cleanup(1); };
function cleanup(code) {
  try { process.kill(-worker.pid, "SIGKILL"); } catch { worker.kill("SIGKILL"); }
  tg.close();
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

let uid = 0, seq = 0;
const from = (id, n) => ({ id, is_bot: false, first_name: n });
async function post(update, secret = SECRET) {
  return fetch(`http://127.0.0.1:${WORKER_PORT}/webhook`, {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: ++uid, ...update }),
  });
}
const say = (id, n, text) => post({ message: { message_id: ++seq, date: 0, chat: { id, type: "private" }, from: from(id, n), text,
  entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined } });
const click = (id, n, data) => post({ callback_query: { id: String(++seq), from: from(id, n), chat_instance: "x", data,
  message: { message_id: 1, date: 0, chat: { id, type: "private" } } } });

try {
  for (let i = 0; i < 90; i++) { try { if ((await fetch(`http://127.0.0.1:${WORKER_PORT}/`)).ok) break; } catch {} await sleep(500); if (i === 89) fail("worker did not start"); }
  const bad = await post({ message: {} }, "wrong");
  if (bad.status !== 401) fail(`wrong secret should be 401, got ${bad.status}`);

  await say(1, "Org", "/new");
  await say(1, "Org", "Smoke game");
  const created = log.filter((l) => l.method === "sendMessage" && l.chat_id === 1).map((l) => l.text).find((t) => t.includes("start="));
  if (!created) fail("no invite link sent");
  const code = /start=([\w-]+)/.exec(created)[1];
  await say(2, "Ann", `/start ${code}`);
  await say(3, "Bob", `/start ${code}`);
  await click(2, "Ann", "wa:1");
  await say(2, "Ann", "Book");

  // не у всех есть подарки -> жеребьёвка не проходит, организатору перечислены неготовые
  await click(1, "Org", "mdy:1");
  await sleep(1500);
  const refusal = log.find((l) => l.method === "editMessageText" && /не все добавили подарки/.test(l.text ?? ""));
  if (!refusal) fail("draw should be refused while someone has no gifts");
  if (log.some((l) => /Тайный Санта для/.test(l.text ?? ""))) fail("pairs must not be sent before everyone added gifts");

  await click(1, "Org", "wa:1");
  await say(1, "Org", "Coffee");
  await click(3, "Bob", "wa:1");
  await say(3, "Bob", "Tea");
  await click(1, "Org", "mdy:1");
  for (let i = 0; i < 40 && log.filter((l) => l.method === "sendMessage" && /Тайный Санта для/.test(l.text ?? "")).length < 3; i++) await sleep(500);
  const dms = log.filter((l) => l.method === "sendMessage" && /Тайный Санта для/.test(l.text ?? ""));
  const chats = new Set(dms.map((d) => d.chat_id));
  if (dms.length !== 3 || chats.size !== 3) fail(`expected 3 distinct DMs via queue, got ${dms.length} to ${[...chats]}`);
  console.log("OK: webhook 401 on bad secret; draw refused until all added gifts; then delivered via queue to", [...chats].join(", "));
  cleanup(0);
} catch (e) { fail(String(e)); }
