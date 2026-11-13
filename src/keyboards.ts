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

/** 👑 — игры, где пользователь организатор; 🎄 — где участник. */
export const gamesList = (games: Game[], uid: number): Markup =>
  kb(
    ...games.map((g) => [btn(`${g.organizer_id === uid ? "👑" : "🎄"} ${short(g.title)}`, `g:${g.id}`)]),
    [btn("➕ Создать игру", "new")],
  );

export function gameMenu(game: Game, isOrg: boolean, wishCount: number): Markup {
  const gid = game.id;
  const drawn = game.status === "drawn";
  const rows: Button[][] = [
    [btn(`📝 Мой список (${wishCount})`, `w:${gid}`)],
    [btn("➕ Добавить подарок", `wa:${gid}`)],
  ];
  if (!drawn) rows.push([btn("🔗 Пригласить участников", `il:${gid}`)]);
  if (drawn) rows.push([btn("🎯 Кому я дарю", `to:${gid}`)]);
  if (isOrg) rows.push([btn("⚙️ Управление игрой", `m:${gid}`)]);
  else if (!drawn) rows.push([btn("🚪 Выйти из игры", `lv:${gid}`)]);
  rows.push([btn("⬅️ Мои игры", "menu")]); // создание игры — на экране «Мои игры» и по /new
  return kb(...rows);
}

const readyButton = (gid: number, ready: boolean): Button =>
  ready ? btn("↩️ Вернуть список в работу", `rd:${gid}`) : btn("✅ Мой список готов", `rd:${gid}`);

export const back = (gid: number): Markup => kb([btn("⬅️ В меню игры", `g:${gid}`)]);

/** «Готов» — только здесь, где виден сам список. ready === undefined — игра разыграна, кнопки нет. */
export const myWishlist = (gid: number, wishes: Wish[], ready?: boolean): Markup =>
  kb(
    ...wishes.map((w, i) => [btn(`${i + 1}. ${short(w.text)}`, `wi:${gid}:${w.id}`)]),
    [btn("➕ Добавить подарок", `wa:${gid}`)],
    ...(ready === undefined ? [] : [[readyButton(gid, ready)]]),
    [btn("⬅️ В меню игры", `g:${gid}`)],
  );

export const wishItem = (gid: number, w: Wish): Markup =>
  kb(
    [btn("✏️ Изменить", `we:${gid}:${w.id}`), btn("🗑 Удалить", `wd:${gid}:${w.id}`)],
    [
      btn(w.url ? "🔗 Изменить ссылку" : "🔗 Добавить ссылку", `wl:${gid}:${w.id}`),
      btn(w.price ? "💰 Изменить цену" : "💰 Добавить цену", `wp:${gid}:${w.id}`),
    ],
    ...(w.url || w.price
      ? [[
          ...(w.url ? [btn("❌ Убрать ссылку", `wlx:${gid}:${w.id}`)] : []),
          ...(w.price ? [btn("❌ Убрать цену", `wpx:${gid}:${w.id}`)] : []),
        ]]
      : []),
    [btn("⬅️ К списку", `w:${gid}`)],
  );

export const afterWish = (gid: number, wid: number): Markup =>
  kb(
    [btn("➕ Добавить ещё", `wa:${gid}`)],
    [btn("🔗 Добавить ссылку", `wl:${gid}:${wid}`), btn("💰 Добавить цену", `wp:${gid}:${wid}`)],
    [btn("📝 Мой список", `w:${gid}`)],
    [btn("⬅️ В меню игры", `g:${gid}`)],
  );

export const cancelInput = (gid: number): Markup => kb([btn("✖️ Отмена", `g:${gid}`)]);
export const cancelToDeadline = (gid: number): Markup => kb([btn("✖️ Отмена", `dl:${gid}`)]);
export const cancelToItem = (gid: number, wid: number): Markup => kb([btn("✖️ Отмена", `wi:${gid}:${wid}`)]);

export function manage(gid: number, open: boolean): Markup {
  const rows: Button[][] = [
    [btn("👥 Участники", `mp:${gid}`)],
    [btn("🚫 Правила «кто кому не дарит»", `mr:${gid}`)],
    [btn("🔗 Ссылка-приглашение", `ml:${gid}`)],
  ];
  if (open) rows.push([btn("📅 Дедлайн", `dl:${gid}`)]);
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

/** items: правила с подписью из имён участников, чтобы было видно, какое именно удаляется. */
export function rules(gid: number, items: { id: number; label: string }[], open: boolean): Markup {
  const rows: Button[][] = [];
  if (open) {
    items.forEach((r, i) => rows.push([btn(`🗑 ${i + 1}. ${short(r.label, 45)}`, `mrd:${gid}:${r.id}`)]));
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

export const deadlineMenu = (gid: number, has: boolean): Markup =>
  kb(
    [btn(has ? "✏️ Изменить дату" : "📅 Задать дедлайн", `dls:${gid}`)],
    ...(has ? [[btn("❌ Убрать дедлайн", `dlx:${gid}`)]] : []),
    [btn("⬅️ Управление", `m:${gid}`)],
  );

const TZ_OFFSETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/** Выбор часового пояса; дата зашита в кнопку числом YYYYMMDD, поэтому отдельное состояние не нужно. */
export const tzPicker = (gid: number, ymd: number): Markup =>
  kb(
    ...[0, 4, 8].map((i) => TZ_OFFSETS.slice(i, i + 4).map((o) => btn(`UTC+${o}`, `dz:${gid}:${ymd}:${o}`))),
    [btn("UTC+0", `dz:${gid}:${ymd}:0`)],
    [btn("✖️ Отмена", `dl:${gid}`)],
  );

export const openGame = (gid: number): Markup => kb([btn("🎄 Открыть игру", `g:${gid}`)]);

export const drawRetry = (gid: number): Markup =>
  kb([btn("🚫 Открыть правила", `mr:${gid}`)], [btn("⬅️ Управление", `m:${gid}`)]);
