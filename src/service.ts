import { MAX_PLAYERS, MAX_RULES, MAX_TITLE_LEN, MAX_WISHES, MAX_WISH_LEN, MIN_PLAYERS } from "./config";
import type { Database, Game, Player } from "./db";
import { DrawImpossible, makeDraw } from "./draw";

export { DrawImpossible };

/** Ошибка, текст которой можно показать пользователю как есть. */
export class UserError extends Error {}

/** Жеребьёвка невозможна, пока не все добавили подарки. */
export class MissingWishesError extends UserError {
  constructor(public missing: Player[]) {
    super("Не все участники добавили подарки.");
  }
}

export type JoinResult = "joined" | "already" | "closed" | "full" | "not_found";

export function cleanText(text: string | undefined | null, limit: number, what: string): string {
  const t = (text ?? "").trim();
  if (!t) throw new UserError(`${what} не может быть пустым.`);
  const len = [...t].length; // считаем символы, а не UTF-16 единицы (эмодзи — один символ)
  if (len > limit) throw new UserError(`Слишком длинно: ${len} символов, максимум ${limit}. Сократите, пожалуйста.`);
  return t;
}

export class Service {
  constructor(public db: Database) {}

  // --- доступ ----------------------------------------------------------
  async gameForPlayer(gameId: number, userId: number): Promise<Game> {
    const game = await this.db.getGame(gameId);
    if (!game || !(await this.db.isPlayer(gameId, userId))) throw new UserError("Вы не участвуете в этой игре.");
    return game;
  }
  async gameForOrganizer(gameId: number, userId: number): Promise<Game> {
    const game = await this.db.getGame(gameId);
    if (!game || game.organizer_id !== userId) throw new UserError("Это действие доступно только организатору игры.");
    return game;
  }
  async organizerOpenGame(gameId: number, userId: number): Promise<Game> {
    const game = await this.gameForOrganizer(gameId, userId);
    if (game.status !== "open") throw new UserError("Жеребьёвка уже проведена, изменить это нельзя.");
    return game;
  }

  // --- игры и участники ------------------------------------------------
  async createGame(title: string | undefined, userId: number, userName: string): Promise<Game> {
    return this.db.createGame(cleanText(title, MAX_TITLE_LEN, "Название"), userId, userName);
  }

  async join(code: string, userId: number, userName: string): Promise<{ result: JoinResult; game: Game | null }> {
    const game = await this.db.getGameByCode(code);
    if (!game) return { result: "not_found", game: null };
    if (await this.db.isPlayer(game.id, userId)) return { result: "already", game };
    if (game.status !== "open") return { result: "closed", game };
    if ((await this.db.getPlayers(game.id)).length >= MAX_PLAYERS) return { result: "full", game };
    // атомарно: если жеребьёвка успела пройти между проверкой и вставкой — вход закрыт
    if (!(await this.db.addPlayer(game.id, userId, userName))) return { result: "closed", game };
    return { result: "joined", game };
  }

  /** Удаляет игру (организатор, в любой момент). Возвращает игру и её участников для уведомлений. */
  async deleteGame(gameId: number, organizerId: number): Promise<{ game: Game; players: Player[] }> {
    const game = await this.gameForOrganizer(gameId, organizerId);
    const players = await this.db.getPlayers(gameId);
    await this.db.deleteGame(gameId);
    return { game, players };
  }

  async removePlayer(gameId: number, organizerId: number, targetId: number): Promise<Player> {
    await this.organizerOpenGame(gameId, organizerId);
    if (targetId === organizerId) throw new UserError("Организатор не может убрать сам себя.");
    const player = await this.db.getPlayer(gameId, targetId);
    if (!player) throw new UserError("Этого участника уже нет в игре.");
    await this.db.removePlayer(gameId, targetId);
    return player;
  }

  async leave(gameId: number, userId: number): Promise<void> {
    const game = await this.gameForPlayer(gameId, userId);
    if (game.organizer_id === userId) throw new UserError("Организатор не может выйти из своей игры.");
    if (game.status !== "open") throw new UserError("Жеребьёвка уже проведена, выйти нельзя.");
    await this.db.removePlayer(gameId, userId);
  }

  // --- подарки ---------------------------------------------------------
  async addWish(gameId: number, userId: number, text: string | undefined): Promise<number> {
    await this.gameForPlayer(gameId, userId);
    const t = cleanText(text, MAX_WISH_LEN, "Пункт");
    if ((await this.db.getWishes(gameId, userId)).length >= MAX_WISHES)
      throw new UserError(`В списке уже ${MAX_WISHES} пунктов — это максимум. Удалите что-нибудь.`);
    return this.db.addWish(gameId, userId, t);
  }

  async ownWish(gameId: number, userId: number, wishId: number) {
    await this.gameForPlayer(gameId, userId);
    const wish = await this.db.getWish(wishId);
    if (!wish || wish.game_id !== gameId || wish.user_id !== userId) throw new UserError("Такого пункта уже нет.");
    return wish;
  }
  async editWish(gameId: number, userId: number, wishId: number, text: string | undefined): Promise<void> {
    await this.ownWish(gameId, userId, wishId);
    await this.db.updateWish(wishId, cleanText(text, MAX_WISH_LEN, "Пункт"));
  }
  async deleteWish(gameId: number, userId: number, wishId: number): Promise<void> {
    await this.ownWish(gameId, userId, wishId);
    await this.db.deleteWish(wishId);
  }

  /** Кто дарит этому человеку (для анонимных уведомлений). null до жеребьёвки. */
  santaOf(gameId: number, userId: number): Promise<number | null> {
    return this.db.getGiver(gameId, userId);
  }

  // --- правила ---------------------------------------------------------
  async createRule(gameId: number, organizerId: number, members: Set<number>): Promise<number> {
    await this.organizerOpenGame(gameId, organizerId);
    if (members.size < 2) throw new UserError("В группе должно быть минимум 2 человека.");
    const valid = new Set((await this.db.getPlayers(gameId)).map((p) => p.user_id));
    for (const m of members) if (!valid.has(m)) throw new UserError("Некоторых выбранных людей уже нет в игре.");
    const existing = await this.db.getRules(gameId);
    const dup = existing.findIndex((r) => r.members.length === members.size && r.members.every((m) => members.has(m)));
    if (dup >= 0) throw new UserError(`Такая группа уже есть в правилах (№${dup + 1}). Повторять её не нужно.`);
    if (existing.length >= MAX_RULES) throw new UserError(`Слишком много правил (максимум ${MAX_RULES}).`);
    return this.db.addRule(gameId, [...members].sort((a, b) => a - b));
  }
  async deleteRule(gameId: number, organizerId: number, ruleId: number): Promise<void> {
    await this.organizerOpenGame(gameId, organizerId);
    await this.db.deleteRule(gameId, ruleId);
  }

  // --- жеребьёвка ------------------------------------------------------
  /** Проводит жеребьёвку. DrawImpossible — если с правилами решения нет. */
  async runDraw(gameId: number, organizerId: number): Promise<Map<number, number>> {
    await this.organizerOpenGame(gameId, organizerId);
    const players = (await this.db.getPlayers(gameId)).map((p) => p.user_id);
    if (players.length < MIN_PLAYERS) throw new UserError(`Для жеребьёвки нужно минимум ${MIN_PLAYERS} участника.`);
    const missing = await this.db.playersWithoutWishes(gameId);
    if (missing.length) throw new MissingWishesError(missing);
    const rules = (await this.db.getRules(gameId)).map((r) => r.members);
    const assignment = makeDraw(players, rules); // может бросить DrawImpossible
    if (!(await this.db.saveDraw(gameId, assignment))) {
      const fresh = await this.db.getGame(gameId);
      throw new UserError(
        fresh && fresh.status === "open"
          ? "Состав участников изменился во время жеребьёвки. Попробуйте ещё раз."
          : "Жеребьёвка уже проведена.",
      );
    }
    return assignment;
  }
}
