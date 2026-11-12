import { Bot, type Context, GrammyError } from "grammy";
import { MAX_PLAYERS, MIN_PLAYERS } from "./config";
import type { Database } from "./db";
import * as kb from "./keyboards";
import type { Markup } from "./keyboards";
import { type OutMsg, type Outbox } from "./outbox";
import { DrawImpossible, Service, UserError } from "./service";
import * as t from "./texts";

const { e } = t;
const HTML = "HTML" as const;

type Handler = (ctx: Context, ...ids: number[]) => Promise<void>;

function nameOf(ctx: Context): string {
  const u = ctx.from!;
  return t.displayName([u.first_name, u.last_name].filter(Boolean).join(" "), u.username);
}

async function safeSend(ctx: Context, chatId: number, text: string, markup?: Markup): Promise<boolean> {
  try {
    await ctx.api.sendMessage(chatId, text, { parse_mode: HTML, reply_markup: markup });
    return true;
  } catch (err) {
    if (err instanceof GrammyError) return false; // заблокировал бота и т. п.
    throw err;
  }
}

/** Редактирует сообщение с кнопкой или отправляет новое в ответ на текст. */
async function show(ctx: Context, text: string, markup?: Markup): Promise<void> {
  const opts = { parse_mode: HTML, reply_markup: markup };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, opts);
    } catch (err) {
      if (err instanceof GrammyError && /not modified/i.test(err.description)) return;
      await ctx.api.sendMessage(ctx.from!.id, text, opts);
    }
  } else {
    await ctx.reply(text, opts);
  }
}

/** Регистрирует все обработчики на переданном боте. */
export function registerHandlers(bot: Bot, db: Database, outbox: Outbox): void {
  const svc = new Service(db);

  // ------------------------------------------------------------ экраны
  async function screenGames(ctx: Context, uid: number, forceList = false): Promise<void> {
    const games = await db.gamesOfUser(uid);
    if (games.length === 1 && !forceList) return screenGame(ctx, uid, games[0].id);
    if (!games.length) return show(ctx, t.WELCOME + "\n\n" + t.NO_GAMES, kb.gamesList([]));
    await show(ctx, "🎅 <b>Ваши игры</b>", kb.gamesList(games));
  }

  async function screenGame(ctx: Context, uid: number, gid: number): Promise<void> {
    const game = await svc.gameForPlayer(gid, uid);
    const isOrg = game.organizer_id === uid;
    const [players, wishes, games] = await Promise.all([
      db.getPlayers(gid),
      db.getWishes(gid, uid),
      db.gamesOfUser(uid),
    ]);
    await show(ctx, t.gameMenu(game, players.length, isOrg), kb.gameMenu(game, isOrg, wishes.length, games.length > 1));
  }

  async function screenWishlist(ctx: Context, uid: number, gid: number): Promise<void> {
    const game = await svc.gameForPlayer(gid, uid);
    const wishes = await db.getWishes(gid, uid);
    await show(ctx, t.myWishlist(wishes, game.status === "drawn"), kb.myWishlist(gid, wishes));
  }

  async function screenManage(ctx: Context, uid: number, gid: number): Promise<void> {
    const game = await svc.gameForOrganizer(gid, uid);
    const open = game.status === "open";
    let text = t.gameMenu(game, (await db.getPlayers(gid)).length, true) + "\n\n⚙️ <b>Управление игрой</b>";
    if (!open) text += "\nЖеребьёвка проведена: участников и правила менять нельзя.";
    await show(ctx, text, kb.manage(gid, open));
  }

  async function screenPlayers(ctx: Context, uid: number, gid: number): Promise<void> {
    const game = await svc.gameForOrganizer(gid, uid);
    const plist = await db.getPlayers(gid);
    const lines = plist.map((p, i) => `${i + 1}. ${e(p.name)}${p.user_id === game.organizer_id ? " 👑" : ""}`);
    const open = game.status === "open";
    let text = `👥 <b>Участники</b> (${plist.length})\n\n${lines.join("\n")}`;
    if (open) text += "\n\nМожно убрать участника до жеребьёвки.";
    await show(ctx, text, kb.players(gid, plist, game.organizer_id, open));
  }

  async function screenRules(ctx: Context, uid: number, gid: number): Promise<void> {
    const game = await svc.gameForOrganizer(gid, uid);
    const names = new Map((await db.getPlayers(gid)).map((p) => [p.user_id, p.name]));
    const rules = await db.getRules(gid);
    let text =
      "🚫 <b>Правила «кто кому не дарит»</b>\nПравило — группа от 2 человек (например, живут вместе): внутри группы никто никому не достаётся.\n\n";
    text += rules.length
      ? rules.map((r, i) => `${i + 1}. ` + r.members.map((m) => e(names.get(m) ?? "?")).join(", ")).join("\n")
      : "<i>Правил пока нет.</i>";
    await show(ctx, text, kb.rules(gid, rules.map((r) => r.id), game.status === "open"));
  }

  async function screenTarget(ctx: Context, uid: number, gid: number): Promise<void> {
    const game = await svc.gameForPlayer(gid, uid);
    const target = await db.getReceiver(gid, uid);
    if (game.status !== "drawn" || target === null) throw new UserError("Жеребьёвка ещё не проведена.");
    const player = (await db.getPlayer(gid, target))!;
    await show(ctx, t.assignment(game.title, player.name, await db.getWishes(gid, target)), kb.back(gid));
  }

  /** Если жеребьёвка была, анонимно сообщаем Санте об изменении списка. */
  async function notifySanta(ctx: Context, gid: number, uid: number): Promise<void> {
    const santa = await svc.santaOf(gid, uid);
    if (santa === null) return;
    const player = (await db.getPlayer(gid, uid))!;
    await safeSend(ctx, santa, t.wishesUpdated(player.name, await db.getWishes(gid, uid)));
  }

  async function inviteLink(ctx: Context, code: string): Promise<string> {
    return `https://t.me/${ctx.me.username}?start=${code}`;
  }

  // -------------------------------------------- действия (callback-кнопки)
  const routes = new Map<string, { fn: Handler; n: number; clear: boolean }>();
  const route = (action: string, n: number, fn: Handler, clear = true) => routes.set(action, { fn, n, clear });
  const uidOf = (ctx: Context) => ctx.from!.id;

  route("menu", 0, (ctx) => screenGames(ctx, uidOf(ctx), true));
  route("new", 0, async (ctx) => {
    await db.setState(uidOf(ctx), "title");
    await show(ctx, t.ASK_TITLE);
  });
  route("g", 1, (ctx, gid) => screenGame(ctx, uidOf(ctx), gid));
  route("w", 1, (ctx, gid) => screenWishlist(ctx, uidOf(ctx), gid));
  route("wa", 1, async (ctx, gid) => {
    await svc.gameForPlayer(gid, uidOf(ctx));
    await db.setState(uidOf(ctx), "wish_add", { gid });
    await show(ctx, t.ASK_WISH, kb.cancelInput(gid));
  });
  route("wi", 2, async (ctx, gid, wid) => {
    const wish = await svc.ownWish(gid, uidOf(ctx), wid);
    await show(ctx, `🎁 ${e(wish.text)}`, kb.wishItem(gid, wid));
  });
  route("we", 2, async (ctx, gid, wid) => {
    const wish = await svc.ownWish(gid, uidOf(ctx), wid);
    await db.setState(uidOf(ctx), "wish_edit", { gid, wid });
    await show(ctx, `Сейчас: ${e(wish.text)}\n\nОтправьте новый текст.`, kb.cancelInput(gid));
  });
  route("wd", 2, async (ctx, gid, wid) => {
    await svc.deleteWish(gid, uidOf(ctx), wid);
    await screenWishlist(ctx, uidOf(ctx), gid);
    await notifySanta(ctx, gid, uidOf(ctx));
  });
  route("to", 1, (ctx, gid) => screenTarget(ctx, uidOf(ctx), gid));
  route("lv", 1, async (ctx, gid) => {
    await svc.gameForPlayer(gid, uidOf(ctx));
    await show(
      ctx,
      "Выйти из игры? Ваш список подарков будет удалён.",
      kb.confirm(`lvy:${gid}`, `g:${gid}`, "🚪 Да, выйти", "⬅️ Остаться"),
    );
  });
  route("lvy", 1, async (ctx, gid) => {
    const game = await svc.gameForPlayer(gid, uidOf(ctx));
    await svc.leave(gid, uidOf(ctx));
    await safeSend(ctx, game.organizer_id, `👋 Участник ${e(nameOf(ctx))} вышел из игры «${e(game.title)}».`);
    await screenGames(ctx, uidOf(ctx));
  });
  route("m", 1, (ctx, gid) => screenManage(ctx, uidOf(ctx), gid));
  route("ml", 1, async (ctx, gid) => {
    const game = await svc.gameForOrganizer(gid, uidOf(ctx));
    await show(ctx, t.invite(await inviteLink(ctx, game.code)), kb.backManage(gid));
  });
  route("mp", 1, (ctx, gid) => screenPlayers(ctx, uidOf(ctx), gid));
  route("mpr", 2, async (ctx, gid, target) => {
    await svc.organizerOpenGame(gid, uidOf(ctx));
    const player = await db.getPlayer(gid, target);
    if (!player || target === uidOf(ctx)) throw new UserError("Этого участника нельзя убрать.");
    await show(
      ctx,
      `Убрать ${e(player.name)} из игры? Его список подарков удалится.`,
      kb.confirm(`mpy:${gid}:${target}`, `mp:${gid}`, "❌ Убрать", "⬅️ Отмена"),
    );
  });
  route("mpy", 2, async (ctx, gid, target) => {
    const game = await svc.gameForOrganizer(gid, uidOf(ctx));
    await svc.removePlayer(gid, uidOf(ctx), target);
    await safeSend(ctx, target, `Организатор убрал вас из игры «${e(game.title)}».`);
    await screenPlayers(ctx, uidOf(ctx), gid);
  });
  route("mr", 1, (ctx, gid) => screenRules(ctx, uidOf(ctx), gid));
  route("mra", 1, async (ctx, gid) => {
    await svc.organizerOpenGame(gid, uidOf(ctx));
    await db.setState(uidOf(ctx), "rule", { gid, sel: [] });
    await showPicker(ctx, gid, new Set());
  });
  async function showPicker(ctx: Context, gid: number, selected: Set<number>): Promise<void> {
    await show(
      ctx,
      "Отметьте людей, которые не должны дарить друг другу (минимум 2):",
      kb.rulePicker(gid, await db.getPlayers(gid), selected),
    );
  }
  route(
    "mrt",
    2,
    async (ctx, gid, uid) => {
      await svc.organizerOpenGame(gid, uidOf(ctx));
      const st = await db.getState(uidOf(ctx));
      const sel = new Set<number>(st && st.state === "rule" && st.data.gid === gid ? st.data.sel : []);
      if (!sel.delete(uid)) sel.add(uid);
      await db.setState(uidOf(ctx), "rule", { gid, sel: [...sel].sort((a, b) => a - b) });
      await showPicker(ctx, gid, sel);
    },
    false,
  );
  route(
    "mrs",
    1,
    async (ctx, gid) => {
      const st = await db.getState(uidOf(ctx));
      const sel = new Set<number>(st && st.state === "rule" && st.data.gid === gid ? st.data.sel : []);
      await svc.createRule(gid, uidOf(ctx), sel);
      await db.clearState(uidOf(ctx));
      await screenRules(ctx, uidOf(ctx), gid);
    },
    false,
  );
  route("mrd", 2, async (ctx, gid, rid) => {
    await svc.deleteRule(gid, uidOf(ctx), rid);
    await screenRules(ctx, uidOf(ctx), gid);
  });
  route("mx", 1, async (ctx, gid) => {
    const game = await svc.gameForOrganizer(gid, uidOf(ctx));
    await show(
      ctx,
      `Удалить игру «${e(game.title)}»? Все участники получат уведомление, а списки подарков и пары будут стёрты без возможности восстановления.`,
      kb.confirm(`mxy:${gid}`, `m:${gid}`, "🗑 Да, удалить", "⬅️ Отмена"),
    );
  });
  route("mxy", 1, async (ctx, gid) => {
    const { game, players } = await svc.deleteGame(gid, uidOf(ctx));
    await outbox.send(
      players
        .filter((p) => p.user_id !== game.organizer_id)
        .map((p) => ({ chat: p.user_id, text: `🗑 Организатор удалил игру «${e(game.title)}».` })),
    );
    await screenGames(ctx, uidOf(ctx));
  });
  route("md", 1, async (ctx, gid) => {
    const game = await svc.organizerOpenGame(gid, uidOf(ctx));
    const n = (await db.getPlayers(gid)).length;
    if (n < MIN_PLAYERS) throw new UserError(`Для жеребьёвки нужно минимум ${MIN_PLAYERS} участника, сейчас ${n}.`);
    await show(
      ctx,
      `Запустить жеребьёвку в «${e(game.title)}»? Участников: ${n}.\n\n` +
        "После этого новые участники вступить не смогут, а правила менять нельзя.",
      kb.confirm(`mdy:${gid}`, `m:${gid}`, "🎲 Запустить", "⬅️ Отмена"),
    );
  });
  route("mdy", 1, async (ctx, gid) => {
    const game = await svc.gameForOrganizer(gid, uidOf(ctx));
    let assignment: Map<number, number>;
    try {
      assignment = await svc.runDraw(gid, uidOf(ctx));
    } catch (err) {
      if (err instanceof DrawImpossible) {
        await show(ctx, t.drawImpossible(game.title), kb.drawRetry(gid));
        return;
      }
      throw err;
    }
    const players = new Map((await db.getPlayers(gid)).map((p) => [p.user_id, p.name]));
    const messages: OutMsg[] = [];
    for (const [giver, receiver] of assignment) {
      messages.push({
        chat: giver,
        text: t.assignment(game.title, players.get(receiver)!, await db.getWishes(gid, receiver)),
        markup: kb.back(gid),
        failNotify: {
          chat: game.organizer_id,
          text: `⚠️ Не удалось доставить пару участнику ${e(players.get(giver)!)}. Пусть откроет бота и нажмёт «🎯 Кому я дарю» в меню игры.`,
        },
      });
    }
    await outbox.send(messages);
    await show(
      ctx,
      "🎉 Жеребьёвка проведена! Участникам рассылаются личные сообщения со своей парой — это занимает несколько секунд. " +
        "Если кому-то не дойдёт, я сообщу.\n\nВаша пара придёт вам отдельным сообщением; чужих пар вы не видите.",
      kb.backManage(gid),
    );
  });

  bot.on("callback_query:data", async (ctx) => {
    const [action, ...raw] = ctx.callbackQuery.data.split(":");
    const r = routes.get(action);
    try {
      if (!r || raw.length !== r.n || raw.some((x) => !/^-?\d+$/.test(x))) throw new UserError(t.STALE);
      if (r.clear) await db.clearState(uidOf(ctx));
      await r.fn(ctx, ...raw.map(Number));
    } catch (err) {
      if (err instanceof UserError) {
        await ctx.answerCallbackQuery({ text: err.message, show_alert: true });
        return;
      }
      throw err;
    }
    await ctx.answerCallbackQuery();
  });

  // ----------------------------------------------------------- команды
  bot.command("start", async (ctx) => {
    const uid = uidOf(ctx);
    const name = nameOf(ctx);
    await db.clearState(uid);
    await db.updatePlayerName(uid, name);
    const code = String(ctx.match ?? "").trim();
    if (!code) return screenGames(ctx, uid);
    const { result, game } = await svc.join(code, uid, name);
    if (result === "not_found") {
      await ctx.reply("Игра по этой ссылке не найдена. Попросите организатора прислать ссылку заново.");
      return screenGames(ctx, uid);
    }
    const title = e(game!.title);
    if (result === "closed") {
      await ctx.reply(`В игре «${title}» жеребьёвка уже проведена — вступить нельзя.`);
      return screenGames(ctx, uid);
    }
    if (result === "full") {
      await ctx.reply(`В игре «${title}» уже максимум участников (${MAX_PLAYERS}).`);
      return screenGames(ctx, uid);
    }
    if (result === "joined") {
      await ctx.reply(`Вы в игре «${title}»! 🎉 Добавьте в список подарки, которые хотели бы получить.`);
      const count = (await db.getPlayers(game!.id)).length;
      await safeSend(ctx, game!.organizer_id, `👤 Новый участник игры «${title}»: ${e(name)}. Всего: ${count}.`);
    }
    await screenGame(ctx, uid, game!.id);
  });

  bot.command("menu", async (ctx) => {
    await db.clearState(uidOf(ctx));
    await screenGames(ctx, uidOf(ctx));
  });
  bot.command("new", async (ctx) => {
    await db.setState(uidOf(ctx), "title");
    await ctx.reply(t.ASK_TITLE);
  });
  bot.command("cancel", async (ctx) => {
    await db.clearState(uidOf(ctx));
    await ctx.reply(t.CANCELLED);
    await screenGames(ctx, uidOf(ctx));
  });

  // --------------------------------------------------- ввод текста (FSM)
  async function afterWishSaved(ctx: Context, gid: number, saved: string): Promise<void> {
    const uid = uidOf(ctx);
    await db.clearState(uid);
    const game = (await db.getGame(gid))!;
    await ctx.reply(`${saved} ✅\n\n` + t.myWishlist(await db.getWishes(gid, uid), game.status === "drawn"), {
      parse_mode: HTML,
      reply_markup: kb.afterWish(gid),
    });
    await notifySanta(ctx, gid, uid);
  }

  bot.on("message:text", async (ctx) => {
    const uid = uidOf(ctx);
    const text = ctx.message.text;
    const st = text.startsWith("/") ? null : await db.getState(uid);
    if (!st) return void (await ctx.reply(t.UNKNOWN_TEXT));
    try {
      if (st.state === "title") {
        const game = await svc.createGame(text, uid, nameOf(ctx));
        await db.clearState(uid);
        await ctx.reply(
          `Игра «${e(game.title)}» создана! 🎄\n\nСсылка-приглашение:\n${e(await inviteLink(ctx, game.code))}\n\n` +
            "Разошлите её участникам. Когда все вступят — запустите жеребьёвку в «Управление игрой».",
          { parse_mode: HTML },
        );
        await screenGame(ctx, uid, game.id);
      } else if (st.state === "wish_add") {
        await svc.addWish(st.data.gid, uid, text);
        await afterWishSaved(ctx, st.data.gid, "Добавлено");
      } else if (st.state === "wish_edit") {
        await svc.editWish(st.data.gid, uid, st.data.wid, text);
        await afterWishSaved(ctx, st.data.gid, "Изменено");
      } else {
        await ctx.reply(t.UNKNOWN_TEXT);
      }
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      // состояние сохраняется: можно сразу прислать исправленный текст
      const gid = st.data?.gid;
      await ctx.reply(err.message, gid ? { reply_markup: kb.cancelInput(gid) } : undefined);
    }
  });

  bot.on("message", async (ctx) => {
    const st = await db.getState(uidOf(ctx));
    await ctx.reply(st && ["title", "wish_add", "wish_edit"].includes(st.state) ? t.NON_TEXT : t.UNKNOWN_TEXT);
  });
}
