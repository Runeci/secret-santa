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

export function wishlist(wishes: Wish[]): string {
  if (!wishes.length) return "<i>список пока пуст</i>";
  return wishes.map((w, i) => `${i + 1}. ${e(w.text)}`).join("\n");
}

export function gameMenu(game: Game, players: number, isOrg: boolean): string {
  const status = game.status === "open" ? "ждём участников" : "жеребьёвка проведена ✅";
  const role = isOrg ? " · вы организатор" : "";
  return `🎄 <b>${e(game.title)}</b>${role}\nУчастников: ${players} · ${status}`;
}

export function myWishlist(wishes: Wish[], drawn: boolean): string {
  const head = `📝 <b>Ваш список подарков</b> (${wishes.length}/${MAX_WISHES})\n\n${wishlist(wishes)}`;
  if (!wishes.length) return head;
  let tail = "\n\nНажмите на пункт, чтобы изменить или удалить его.";
  if (drawn) tail += "\nВаш Санта получит уведомление об изменениях (анонимно).";
  return head + tail;
}

export const invite = (link: string): string =>
  `🔗 Ссылка-приглашение:\n${e(link)}\n\nОтправьте её тем, кто будет участвовать.`;

export function assignment(title: string, receiverName: string, wishes: Wish[]): string {
  return (
    `🎁 <b>${e(title)}</b>\n\nВы — Тайный Санта для: <b>${e(receiverName)}</b>\n\n` +
    `Что хочет получить:\n${wishlist(wishes)}\n\nЭто секрет — никому не рассказывайте 🤫`
  );
}

export const wishesUpdated = (receiverName: string, wishes: Wish[]): string =>
  `🔔 <b>${e(receiverName)}</b> обновил(а) список желаний. Актуальный список:\n\n${wishlist(wishes)}`;

export const drawImpossible = (title: string): string =>
  `😔 С текущими правилами жеребьёвка в игре «${e(title)}» невозможна: не получается раздать подарки так, ` +
  "чтобы никто не достался себе или человеку из своей группы.\n\n" +
  "Удалите часть правил «кто кому не дарит» и попробуйте снова.";
