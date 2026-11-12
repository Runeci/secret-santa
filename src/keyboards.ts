import type { Game, Player, Wish } from "./db";

export type Button = { text: string; callback_data: string };
export type Markup = { inline_keyboard: Button[][] };

const btn = (text: string, callback_data: string): Button => ({ text, callback_data });
const kb = (...rows: Button[][]): Markup => ({ inline_keyboard: rows });

function short(text: string, n = 40): string {
  const t = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...t];
  return chars.length <= n ? t : chars.slice(0, n - 1).join("") + "…";
}

export const gamesList = (games: Game[]): Markup =>
  kb(...games.map((g) => [btn(`🎄 ${short(g.title)}`, `g:${g.id}`)]), [btn("➕ Создать игру", "new")]);

export function gameMenu(game: Game, isOrg: boolean, wishCount: number, multi: boolean): Markup {
  const gid = game.id;
  const drawn = game.status === "drawn";
  const rows: Button[][] = [
    [btn(`📝 Мой список (${wishCount})`, `w:${gid}`)],
    [btn("➕ Добавить подарок", `wa:${gid}`)],
  ];
  if (drawn) rows.push([btn("🎯 Кому я дарю", `to:${gid}`)]);
  if (isOrg) rows.push([btn("⚙️ Управление игрой", `m:${gid}`)]);
  else if (!drawn) rows.push([btn("🚪 Выйти из игры", `lv:${gid}`)]);
  rows.push([multi ? btn("⬅️ Мои игры", "menu") : btn("➕ Создать игру", "new")]);
  return kb(...rows);
}

export const back = (gid: number): Markup => kb([btn("⬅️ В меню игры", `g:${gid}`)]);

export const myWishlist = (gid: number, wishes: Wish[]): Markup =>
  kb(
    ...wishes.map((w, i) => [btn(`${i + 1}. ${short(w.text)}`, `wi:${gid}:${w.id}`)]),
    [btn("➕ Добавить подарок", `wa:${gid}`)],
    [btn("⬅️ В меню игры", `g:${gid}`)],
  );

export const wishItem = (gid: number, wid: number): Markup =>
  kb(
    [btn("✏️ Изменить", `we:${gid}:${wid}`), btn("🗑 Удалить", `wd:${gid}:${wid}`)],
    [btn("⬅️ К списку", `w:${gid}`)],
  );

export const afterWish = (gid: number): Markup =>
  kb(
    [btn("➕ Добавить ещё", `wa:${gid}`)],
    [btn("📝 Мой список", `w:${gid}`)],
    [btn("⬅️ В меню игры", `g:${gid}`)],
  );

export const cancelInput = (gid: number): Markup => kb([btn("✖️ Отмена", `g:${gid}`)]);

export function manage(gid: number, open: boolean): Markup {
  const rows: Button[][] = [
    [btn("👥 Участники", `mp:${gid}`)],
    [btn("🚫 Правила «кто кому не дарит»", `mr:${gid}`)],
    [btn("🔗 Ссылка-приглашение", `ml:${gid}`)],
  ];
  if (open) rows.push([btn("🎲 Провести жеребьёвку", `md:${gid}`)]);
  rows.push([btn("🗑 Удалить игру", `mx:${gid}`)]);
  rows.push([btn("⬅️ В меню игры", `g:${gid}`)]);
  return kb(...rows);
}

export const backManage = (gid: number): Markup => kb([btn("⬅️ Управление", `m:${gid}`)]);

export function players(gid: number, plist: Player[], organizerId: number, open: boolean): Markup {
  const rows: Button[][] = open
    ? plist
        .filter((p) => p.user_id !== organizerId)
        .map((p) => [btn(`❌ Убрать: ${short(p.name, 30)}`, `mpr:${gid}:${p.user_id}`)])
    : [];
  rows.push([btn("⬅️ Управление", `m:${gid}`)]);
  return kb(...rows);
}

export const confirm = (yes: string, no: string, yesText = "✅ Да", noText = "⬅️ Нет"): Markup =>
  kb([btn(yesText, yes), btn(noText, no)]);

export function rules(gid: number, ruleIds: number[], open: boolean): Markup {
  const rows: Button[][] = [];
  if (open) {
    ruleIds.forEach((rid, i) => rows.push([btn(`🗑 Удалить правило ${i + 1}`, `mrd:${gid}:${rid}`)]));
    rows.push([btn("➕ Добавить правило", `mra:${gid}`)]);
  }
  rows.push([btn("⬅️ Управление", `m:${gid}`)]);
  return kb(...rows);
}

export const rulePicker = (gid: number, plist: Player[], selected: Set<number>): Markup =>
  kb(
    ...plist.map((p) => [btn((selected.has(p.user_id) ? "✅ " : "⬜ ") + short(p.name, 35), `mrt:${gid}:${p.user_id}`)]),
    [btn(`💾 Сохранить (${selected.size})`, `mrs:${gid}`)],
    [btn("✖️ Отмена", `mr:${gid}`)],
  );

export const drawRetry = (gid: number): Markup =>
  kb([btn("🚫 Открыть правила", `mr:${gid}`)], [btn("⬅️ Управление", `m:${gid}`)]);
