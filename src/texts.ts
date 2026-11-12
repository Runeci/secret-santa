/** Тексты (parse_mode HTML). Всё пользовательское обязательно экранируется через e(). */
import { MAX_WISHES, MAX_WISH_LEN } from "./config";
import type { Game, Wish } from "./db";

export const e = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const WELCOME =
  "🎅 <b>Тайный Санта</b>\n\nСоздайте игру и разошлите друзьям ссылку-приглашение — или перейдите по ссылке, которую вам прислали.";
export const NO_GAMES = "У вас пока нет игр. Создайте свою или перейдите по ссылке-приглашению.";
export const ASK_TITLE = "Как назовём игру? Например: «Новый год в офисе». Отправьте название сообщением.";
export const ASK_WISH = `Напишите один подарок, который хотели бы получить (до ${MAX_WISH_LEN} символов). Можно ссылку, размер, цвет — всё, что поможет Санте.`;
export const CANCELLED = "Отменено.";
export const UNKNOWN_TEXT = "Не понял 🤔 Откройте меню: /start";
export const STALE = "Эта кнопка устарела. Откройте меню: /start";
export const NON_TEXT = "Пришлите, пожалуйста, обычное текстовое сообщение.";

export function displayName(fullName: string, username?: string): string {
  return username ? `${fullName} (@${username})` : fullName;
}

const EMPTY = "<i>список пока пуст</i>";
/** Сокращение по символам (эмодзи не режутся пополам). */
const cut = (text: string, n: number): string => {
  const chars = [...text];
  return chars.length <= n ? text : chars.slice(0, n).join("") + "…";
};

/** Строки списка целиком (для Санты: ссылки нельзя сокращать). */
export function wishLines(wishes: Wish[]): string[] {
  return wishes.length ? wishes.map((w, i) => `${i + 1}. ${e(w.text)}`) : [EMPTY];
}

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

export function gameMenu(game: Game, players: number, isOrg: boolean): string {
  const status = game.status === "open" ? "ждём участников" : "жеребьёвка проведена ✅";
  const role = isOrg ? " · вы организатор" : "";
  return `🎄 <b>${e(game.title)}</b>${role}\nУчастников: ${players} · ${status}`;
}

const PREVIEW_LEN = 150;

export function myWishlist(wishes: Wish[], drawn: boolean): string {
  const lines = wishes.length ? wishes.map((w, i) => `${i + 1}. ${e(cut(w.text, PREVIEW_LEN))}`) : [EMPTY];
  const head = `📝 <b>Ваш список подарков</b> (${wishes.length}/${MAX_WISHES})\n\n${lines.join("\n")}`;
  if (!wishes.length) return head;
  let tail = "\n\nНажмите на пункт, чтобы изменить или удалить его.";
  if (wishes.some((w) => [...w.text].length > PREVIEW_LEN))
    tail += "\nДлинные пункты здесь сокращены: полный текст — на странице пункта.";
  if (drawn) tail += "\nВаш Санта получит уведомление об изменениях (анонимно).";
  return head + tail;
}

export const invite = (link: string): string =>
  `🔗 Ссылка-приглашение:\n${e(link)}\n\nОтправьте её тем, кто будет участвовать.`;

/** Сообщение Санте: список целиком, при необходимости в нескольких сообщениях. */
export const assignmentParts = (title: string, receiverName: string, wishes: Wish[]): string[] =>
  splitParts(
    `🎁 <b>${e(title)}</b>\n\nВы — Тайный Санта для: <b>${e(receiverName)}</b>\n\nЧто хочет получить:`,
    wishLines(wishes),
    "\n\nЭто секрет — никому не рассказывайте 🤫",
  );

export const wishesUpdatedParts = (receiverName: string, wishes: Wish[]): string[] =>
  splitParts(`🔔 <b>${e(receiverName)}</b> обновил(а) список желаний. Актуальный список:`, wishLines(wishes), "");

export const drawImpossible = (title: string): string =>
  `😔 С текущими правилами жеребьёвка в игре «${e(title)}» невозможна: не получается раздать подарки так, ` +
  "чтобы никто не достался себе или человеку из своей группы.\n\n" +
  "Удалите часть правил «кто кому не дарит» и попробуйте снова.";
