/** Тексты (parse_mode HTML). Всё пользовательское обязательно экранируется через e(). */
import { MAX_NAME_LEN, MAX_WISHES, MAX_WISH_LEN } from "./config";
import { dayNumber, daysWord, formatRu, localNow, parseYMD, tzLabel } from "./dates";
import type { Game, PlayerReadiness, Wish } from "./db";

/** Сокращение по символам (эмодзи не режутся пополам). */
export const cut = (text: string, n: number): string => {
  const chars = [...text];
  return chars.length <= n ? text : chars.slice(0, n).join("") + "…";
};

export const e = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const WELCOME =
  "🎅 <b>Тайный Санта</b>\n\nСоздайте игру и разошлите друзьям ссылку-приглашение — или перейдите по ссылке, которую вам прислали.";
export const NO_GAMES = "У вас пока нет игр. Создайте свою или перейдите по ссылке-приглашению.";
export const ASK_TITLE = "Как назовём игру? Например: «Новый год в офисе». Отправьте название сообщением.";
export const ASK_WISH = `Напишите один подарок, который хотели бы получить (до ${MAX_WISH_LEN} символов). Можно ссылку, размер, цвет — всё, что поможет Санте.`;
export const ASK_LINK =
  "Пришлите ссылку на подарок (карточка товара, магазин). Например: https://example.com/товар\nЕё можно будет изменить или убрать.";
export const ASK_PRICE = "Напишите примерную стоимость, например: 3000 ₽ или около 50 $.\nЕё можно будет изменить или убрать.";
export const ASK_DEADLINE =
  "📅 Пришлите дату дедлайна: например 20.12 или 20.12.2026.\nДо этой даты участники должны добавить подарки и нажать «Мой список готов».";
export const CANCELLED = "Отменено.";
export const UNKNOWN_TEXT = "Не понял 🤔 Откройте меню: /start";
export const STALE = "Эта кнопка устарела. Откройте меню: /start";
export const NON_TEXT = "Пришлите, пожалуйста, обычное текстовое сообщение.";

export function displayName(fullName: string, username?: string): string {
  const name = cut(fullName.trim() || "Без имени", MAX_NAME_LEN);
  return username ? `${name} (@${username})` : name;
}

const EMPTY = "<i>список пока пуст</i>";
/** Сокращение по символам (эмодзи не режутся пополам). */

/** Строки списка целиком (для Санты: ссылки нельзя сокращать). */
export function wishLines(wishes: Wish[]): string[] {
  return wishes.length ? wishes.map((w, i) => `${i + 1}. ${wishBody(w)}`) : [EMPTY];
}

/** Подарок целиком: название, стоимость и ссылка (ссылка не сокращается — Санте она нужна). */
function wishBody(w: Wish): string {
  return `${e(w.text)}${w.price ? ` — ${e(w.price)}` : ""}${w.url ? `\n🔗 ${e(w.url)}` : ""}`;
}

/** Карточка одного подарка. */
export const wishCard = (w: Wish): string =>
  `🎁 ${e(w.text)}${w.price ? `\n💰 ${e(w.price)}` : ""}${w.url ? `\n🔗 ${e(w.url)}` : ""}`;

export function wishlist(wishes: Wish[]): string {
  return wishLines(wishes).join("\n");
}

/** Потолок сообщения Telegram — 4096 символов; берём с запасом. */
export const PART_LIMIT = 3800;

/** Собирает текст из шапки, строк и подвала, разбивая на несколько сообщений, если не влезает. */
export function splitParts(header: string, lines: string[], footer: string, limit = PART_LIMIT): string[] {
  const parts: string[] = [];
  let cur = header;
  for (const line of lines) {
    if (cur && cur.length + 1 + line.length > limit) {
      parts.push(cur);
      cur = "<i>(продолжение списка)</i>";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur.length + footer.length > limit) {
    parts.push(cur);
    cur = "<i>(продолжение)</i>";
  }
  parts.push(cur + footer);
  return parts;
}

/** Строка про дедлайн для меню игры (null — дедлайна нет). Только для открытых игр. */
export function deadlineLine(game: Game, nowMs: number): string | null {
  if (!game.deadline_date || game.status !== "open") return null;
  const left = dayNumber(parseYMD(game.deadline_date)) - dayNumber(localNow(nowMs, game.tz_offset));
  const date = formatRu(game.deadline_date);
  if (left < 0) return `⚠️ Дедлайн прошёл (${date})`;
  if (left === 0) return `📅 Дедлайн: сегодня, ${date} — последний день`;
  if (left === 1) return `📅 Дедлайн: завтра, ${date}`;
  return `📅 Дедлайн: до ${date} (осталось ${daysWord(left)})`;
}

export function gameMenu(game: Game, players: number, isOrg: boolean, ready?: boolean, wishCount = 1, deadline?: string | null): string {
  const status = game.status === "open" ? "ждём участников" : "жеребьёвка проведена ✅";
  let mine = "";
  if (game.status === "open" && ready !== undefined) {
    mine = `\nВаш список: ${ready ? "готов ✅" : "ещё не готов"}`;
    if (ready && wishCount === 0) mine += " — но подарков в нём нет, добавьте хотя бы один";
  }
  // роль — отдельной строкой, чтобы организатор сразу видел, что он управляет игрой
  const icon = isOrg ? "👑" : "🎄";
  const role = isOrg ? "Вы — организатор" : "Вы — участник";
  return `${icon} <b>${e(game.title)}</b>\n${role}\nУчастников: ${players} · ${status}${deadline ? `\n${deadline}` : ""}${mine}`;
}

const PREVIEW_LEN = 150;

export function myWishlist(wishes: Wish[], drawn: boolean, ready?: boolean): string {
  const lines = wishes.length
    ? wishes.map((w, i) => `${i + 1}. ${e(cut(w.text, PREVIEW_LEN))}${w.price ? ` — ${e(w.price)}` : ""}${w.url ? " 🔗" : ""}`)
    : [EMPTY];
  const state = ready === undefined ? "" : `\nСписок: ${ready ? "готов ✅" : "ещё не готов"}`;
  const head = `📝 <b>Ваш список подарков</b> (${wishes.length}/${MAX_WISHES})${state}\n\n${lines.join("\n")}`;
  if (!wishes.length) return head;
  let tail = "\n\nНажмите на пункт, чтобы изменить или удалить его.";
  if (wishes.some((w) => [...w.text].length > PREVIEW_LEN))
    tail += "\nДлинные пункты здесь сокращены: полный текст — на странице пункта.";
  if (drawn) tail += "\nВаш Санта получит уведомление об изменениях (анонимно).";
  return head + tail;
}

/** Подсказка организатору/участнику: что переслать. */
export const inviteIntro = (title: string): string =>
  `🔗 Перешлите следующее сообщение тем, кого хотите пригласить в игру «${e(title)}»: по ссылке в нём можно вступить.`;

/** Нейтральное приглашение, которое можно переслать как есть: без служебных слов про организатора. */
export const inviteMessage = (title: string, link: string): string =>
  `🎅 Приглашаю в игру «Тайный Санта»: «${e(title)}».\nПерейдите по ссылке, нажмите Start и добавьте подарки, которые хотите получить:\n${e(link)}`;

/** Сообщение Санте: список целиком, при необходимости в нескольких сообщениях. */
export const assignmentParts = (title: string, receiverName: string, wishes: Wish[]): string[] =>
  splitParts(
    `🎁 <b>${e(title)}</b>\n\nВы — Тайный Санта для: <b>${e(receiverName)}</b>\n\nЧто хочет получить:`,
    wishLines(wishes),
    "\n\nЭто секрет — никому не рассказывайте 🤫",
  );

export const wishesUpdatedParts = (receiverName: string, wishes: Wish[]): string[] =>
  splitParts(`🔔 <b>${e(receiverName)}</b> обновил(а) список желаний. Актуальный список:`, wishLines(wishes), "");

/** «1 подарок», «2 подарка», «5 подарков». */
export function giftsLabel(n: number): string {
  if (n === 0) return "нет подарков";
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? "подарок" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "подарка" : "подарков";
  return `${n} ${word}`;
}

/** Строка участника для организатора: имя, число подарков, и (до жеребьёвки) готовность списка. */
export function playerLine(p: PlayerReadiness, i: number, organizerId: number, open: boolean): string {
  const status = open ? (p.ready === 1 && p.wish_count > 0 ? " ✅" : " ⏳") : "";
  return `${i}. ${listName(p.name)}${p.user_id === organizerId ? " 👑" : ""} — ${giftsLabel(p.wish_count)}${status}`;
}

/** Имя в списках: экранировано и ограничено, чтобы список из 50 человек помещался в сообщение. */
export const listName = (n: string): string => e(cut(n, 60));

/** Организатору: чьи списки ещё не готовы и почему (при необходимости — в нескольких сообщениях). */
export function notReadyParts(items: PlayerReadiness[], organizerName?: string): string[] {
  return splitParts(
    "🎁 Жеребьёвку пока провести нельзя: не все списки готовы. Ждём:\n",
    items.map(
      (p) =>
        `• ${listName(p.name)}${p.name === organizerName ? " (вы)" : ""} — ` +
        (p.wish_count === 0 ? "нет подарков" : "не отметил(а) список готовым"),
    ),
    "\n\nПопросите их добавить подарки и нажать «✅ Мой список готов» в меню игры, затем запустите жеребьёвку снова.",
  );
}

export function deadlineScreen(game: Game, nowMs: number): string {
  const head = "📅 <b>Дедлайн</b>\n\n";
  const rules =
    "\n\nБот напоминает тем, кто не нажал «✅ Мой список готов»: по субботам до дедлайна и за день до него. " +
    "Вам, организатору, — сводка за день до дедлайна и в его день.";
  if (!game.deadline_date) return head + "Дедлайн не задан." + rules;
  return `${head}${deadlineLine(game, nowMs)}\nЧасовой пояс: ${tzLabel(game.tz_offset)} (напоминания около 12:00 по нему)${rules}`;
}

export const deadlineSetNotice = (title: string, date: string, tz: number): string =>
  `📅 В игре «${e(title)}» назначен дедлайн: до ${formatRu(date)} (${tzLabel(tz)}).\n` +
  "Добавьте подарки и нажмите «✅ Мой список готов» на экране «📝 Мой список».";
export const deadlineClearedNotice = (title: string): string => `📅 В игре «${e(title)}» дедлайн отменён.`;

export const deadlineReminder = (title: string, date: string, daysLeft: number): string =>
  `⏰ Игра «${e(title)}»: ` +
  (daysLeft === 1 ? "завтра" : `до дедлайна ${daysWord(daysLeft)}`) +
  ` последний день — ${formatRu(date)}.\nВаш список ещё не готов: добавьте подарки и нажмите «✅ Мой список готов» на экране «📝 Мой список».`;

export function deadlineSummaryParts(title: string, daysLeft: number, items: PlayerReadiness[]): string[] {
  const when = daysLeft === 0 ? "сегодня последний день" : "завтра последний день";
  return splitParts(
    `📅 Игра «${e(title)}»: ${when}. Списки ещё не готовы у:\n`,
    items.map((p) => `• ${listName(p.name)} — ${p.wish_count === 0 ? "нет подарков" : "не отметил(а) список готовым"}`),
    "\n\nМожно подтолкнуть их или перенести дедлайн в «Управление игрой» → «📅 Дедлайн».",
  );
}

export const drawImpossible = (title: string): string =>
  `😔 С текущими правилами жеребьёвка в игре «${e(title)}» невозможна: не получается раздать подарки так, ` +
  "чтобы никто не достался себе или человеку из своей группы.\n\n" +
  "Удалите часть правил «кто кому не дарит» и попробуйте снова.";
