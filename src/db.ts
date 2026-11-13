/** Минимальный интерфейс D1 (его реализуют и настоящий D1, и тестовая прослойка над SQLite). */
export interface D1Result<T = unknown> {
  results: T[];
  meta: { changes: number; last_row_id: number };
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Like {
  prepare(query: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<D1Result[]>;
}

export interface Game {
  id: number;
  code: string;
  title: string;
  organizer_id: number;
  status: "open" | "drawn";
  created_at: number;
}
export interface Player {
  game_id: number;
  user_id: number;
  name: string;
  joined_at: number;
  ready: number; // 1 — участник отметил «мой список готов»
}
export type PlayerReadiness = Player & { wish_count: number };
/** Список считается готовым, только если участник нажал «готов» и в списке есть хотя бы один подарок. */
export const isReady = (p: PlayerReadiness): boolean => p.ready === 1 && p.wish_count > 0;
export interface Wish {
  id: number;
  game_id: number;
  user_id: number;
  text: string;
  url: string | null; // необязательная ссылка (проверена)
  price: string | null; // необязательная стоимость
}
export interface Rule {
  id: number;
  members: number[];
}

const now = () => Math.floor(Date.now() / 1000);

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Правила, в которых осталось меньше 2 человек, подлежат удалению.
const SMALL_RULES = `SELECT rule_id FROM rule_members GROUP BY rule_id HAVING COUNT(*) >= 2`;

export class Database {
  constructor(private d: D1Like) {}

  // --- игры ------------------------------------------------------------
  async createGame(title: string, organizerId: number, organizerName: string): Promise<Game> {
    const code = randomCode();
    const t = now();
    await this.d.batch([
      this.d
        .prepare("INSERT INTO games(code, title, organizer_id, status, created_at) VALUES (?,?,?, 'open', ?)")
        .bind(code, title, organizerId, t),
      this.d
        .prepare("INSERT INTO players(game_id, user_id, name, joined_at) SELECT id, ?, ?, ? FROM games WHERE code = ?")
        .bind(organizerId, organizerName, t, code),
    ]);
    return (await this.getGameByCode(code))!;
  }

  getGame(id: number): Promise<Game | null> {
    return this.d.prepare("SELECT * FROM games WHERE id = ?").bind(id).first<Game>();
  }
  getGameByCode(code: string): Promise<Game | null> {
    return this.d.prepare("SELECT * FROM games WHERE code = ?").bind(code).first<Game>();
  }
  async gamesOfUser(userId: number): Promise<Game[]> {
    const r = await this.d
      .prepare("SELECT g.* FROM games g JOIN players p ON p.game_id = g.id WHERE p.user_id = ? ORDER BY g.id")
      .bind(userId)
      .all<Game>();
    return r.results;
  }

  /** Полностью удаляет игру со всеми участниками, подарками, правилами и парами. */
  async deleteGame(gameId: number): Promise<void> {
    const d = this.d;
    await d.batch([
      d.prepare("DELETE FROM assignments WHERE game_id = ?").bind(gameId),
      d.prepare("DELETE FROM wishes WHERE game_id = ?").bind(gameId),
      d.prepare("DELETE FROM rule_members WHERE rule_id IN (SELECT id FROM rules WHERE game_id = ?)").bind(gameId),
      d.prepare("DELETE FROM rules WHERE game_id = ?").bind(gameId),
      d.prepare("DELETE FROM players WHERE game_id = ?").bind(gameId),
      d.prepare("DELETE FROM games WHERE id = ?").bind(gameId),
    ]);
  }

  // --- участники -------------------------------------------------------
  /** Добавляет участника, только если игра ещё открыта (атомарно). false — игра уже разыграна. */
  async addPlayer(gameId: number, userId: number, name: string): Promise<boolean> {
    const r = await this.d
      .prepare(
        "INSERT INTO players(game_id, user_id, name, joined_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM games WHERE id = ? AND status = 'open')",
      )
      .bind(gameId, userId, name, now(), gameId)
      .run();
    return r.meta.changes > 0;
  }
  async updatePlayerName(userId: number, name: string): Promise<void> {
    await this.d.prepare("UPDATE players SET name = ? WHERE user_id = ? AND name <> ?").bind(name, userId, name).run();
  }
  async getPlayers(gameId: number): Promise<Player[]> {
    const r = await this.d
      .prepare("SELECT * FROM players WHERE game_id = ? ORDER BY joined_at, user_id")
      .bind(gameId)
      .all<Player>();
    return r.results;
  }
  getPlayer(gameId: number, userId: number): Promise<Player | null> {
    return this.d.prepare("SELECT * FROM players WHERE game_id = ? AND user_id = ?").bind(gameId, userId).first<Player>();
  }
  async isPlayer(gameId: number, userId: number): Promise<boolean> {
    return (await this.getPlayer(gameId, userId)) !== null;
  }
  /** Все участники с признаком готовности и числом подарков. */
  async getReadiness(gameId: number): Promise<PlayerReadiness[]> {
    const r = await this.d
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM wishes w WHERE w.game_id = p.game_id AND w.user_id = p.user_id) AS wish_count
         FROM players p WHERE p.game_id = ? ORDER BY p.joined_at, p.user_id`,
      )
      .bind(gameId)
      .all<PlayerReadiness>();
    return r.results;
  }
  async setReady(gameId: number, userId: number, ready: boolean): Promise<void> {
    await this.d
      .prepare("UPDATE players SET ready = ? WHERE game_id = ? AND user_id = ?")
      .bind(ready ? 1 : 0, gameId, userId)
      .run();
  }

  /** Убирает участника, его подарки и его из правил; правила < 2 человек удаляются. */
  async removePlayer(gameId: number, userId: number): Promise<void> {
    const d = this.d;
    await d.batch([
      d.prepare("DELETE FROM players WHERE game_id = ? AND user_id = ?").bind(gameId, userId),
      d.prepare("DELETE FROM wishes WHERE game_id = ? AND user_id = ?").bind(gameId, userId),
      d
        .prepare("DELETE FROM rule_members WHERE user_id = ? AND rule_id IN (SELECT id FROM rules WHERE game_id = ?)")
        .bind(userId, gameId),
      d
        .prepare(
          `DELETE FROM rule_members WHERE rule_id IN (SELECT id FROM rules WHERE game_id = ? AND id NOT IN (${SMALL_RULES}))`,
        )
        .bind(gameId),
      d.prepare(`DELETE FROM rules WHERE game_id = ? AND id NOT IN (${SMALL_RULES})`).bind(gameId),
    ]);
  }

  // --- подарки ---------------------------------------------------------
  async getWishes(gameId: number, userId: number): Promise<Wish[]> {
    const r = await this.d
      .prepare("SELECT * FROM wishes WHERE game_id = ? AND user_id = ? ORDER BY id")
      .bind(gameId, userId)
      .all<Wish>();
    return r.results;
  }
  getWish(id: number): Promise<Wish | null> {
    return this.d.prepare("SELECT * FROM wishes WHERE id = ?").bind(id).first<Wish>();
  }
  async addWish(gameId: number, userId: number, text: string): Promise<number> {
    const r = await this.d
      .prepare("INSERT INTO wishes(game_id, user_id, text) VALUES (?,?,?)")
      .bind(gameId, userId, text)
      .run();
    return r.meta.last_row_id;
  }
  async updateWish(id: number, text: string): Promise<void> {
    await this.d.prepare("UPDATE wishes SET text = ? WHERE id = ?").bind(text, id).run();
  }
  async setWishLink(id: number, url: string | null): Promise<void> {
    await this.d.prepare("UPDATE wishes SET url = ? WHERE id = ?").bind(url, id).run();
  }
  async setWishPrice(id: number, price: string | null): Promise<void> {
    await this.d.prepare("UPDATE wishes SET price = ? WHERE id = ?").bind(price, id).run();
  }
  async deleteWish(id: number): Promise<void> {
    await this.d.prepare("DELETE FROM wishes WHERE id = ?").bind(id).run();
  }

  // --- правила ---------------------------------------------------------
  async addRule(gameId: number, members: number[]): Promise<number> {
    const r = await this.d.prepare("INSERT INTO rules(game_id) VALUES (?)").bind(gameId).run();
    const id = r.meta.last_row_id;
    await this.d.batch(
      members.map((m) => this.d.prepare("INSERT INTO rule_members(rule_id, user_id) VALUES (?,?)").bind(id, m)),
    );
    return id;
  }
  async getRules(gameId: number): Promise<Rule[]> {
    const r = await this.d
      .prepare(
        "SELECT r.id AS rid, m.user_id AS uid FROM rules r JOIN rule_members m ON m.rule_id = r.id WHERE r.game_id = ? ORDER BY r.id, m.user_id",
      )
      .bind(gameId)
      .all<{ rid: number; uid: number }>();
    const rules = new Map<number, number[]>();
    for (const row of r.results) {
      if (!rules.has(row.rid)) rules.set(row.rid, []);
      rules.get(row.rid)!.push(row.uid);
    }
    return [...rules].map(([id, members]) => ({ id, members }));
  }
  async deleteRule(gameId: number, ruleId: number): Promise<void> {
    await this.d.batch([
      this.d
        .prepare("DELETE FROM rule_members WHERE rule_id IN (SELECT id FROM rules WHERE id = ? AND game_id = ?)")
        .bind(ruleId, gameId),
      this.d.prepare("DELETE FROM rules WHERE id = ? AND game_id = ?").bind(ruleId, gameId),
    ]);
  }

  // --- жеребьёвка ------------------------------------------------------
  /**
   * Атомарно сохраняет результат и закрывает игру. false — ничего не сохранено: игра уже разыграна
   * или состав участников изменился с момента жеребьёвки (кто-то вступил/вышел).
   * Все условия проверяются в одной транзакции до изменения статуса игры.
   */
  async saveDraw(gameId: number, assignment: Map<number, number>): Promise<boolean> {
    const expected = assignment.size;
    const unchanged = "EXISTS (SELECT 1 FROM games WHERE id = ? AND status = 'open') AND (SELECT COUNT(*) FROM players WHERE game_id = ?) = ?";
    const stmts = [
      ...[...assignment].map(([giver, receiver]) =>
        this.d
          .prepare(
            `INSERT INTO assignments(game_id, giver_id, receiver_id) SELECT ?,?,? WHERE ${unchanged}
             AND EXISTS (SELECT 1 FROM players WHERE game_id = ? AND user_id = ?)`,
          )
          .bind(gameId, giver, receiver, gameId, gameId, expected, gameId, giver),
      ),
      this.d
        .prepare(
          `UPDATE games SET status = 'drawn' WHERE id = ? AND status = 'open'
           AND (SELECT COUNT(*) FROM players WHERE game_id = ?) = ?
           AND (SELECT COUNT(*) FROM assignments WHERE game_id = ?) = ?`,
        )
        .bind(gameId, gameId, expected, gameId, expected),
    ];
    const res = await this.d.batch(stmts);
    if (res[res.length - 1].meta.changes === 1) return true;
    // Отказ: убираем возможные частично вставленные пары (у открытой игры законных пар быть не может).
    await this.d
      .prepare("DELETE FROM assignments WHERE game_id = ? AND EXISTS (SELECT 1 FROM games WHERE id = ? AND status = 'open')")
      .bind(gameId, gameId)
      .run();
    return false;
  }
  async getReceiver(gameId: number, giverId: number): Promise<number | null> {
    const r = await this.d
      .prepare("SELECT receiver_id FROM assignments WHERE game_id = ? AND giver_id = ?")
      .bind(gameId, giverId)
      .first<{ receiver_id: number }>();
    return r ? r.receiver_id : null;
  }
  async getGiver(gameId: number, receiverId: number): Promise<number | null> {
    const r = await this.d
      .prepare("SELECT giver_id FROM assignments WHERE game_id = ? AND receiver_id = ?")
      .bind(gameId, receiverId)
      .first<{ giver_id: number }>();
    return r ? r.giver_id : null;
  }
  async getAssignments(gameId: number): Promise<Map<number, number>> {
    const r = await this.d
      .prepare("SELECT giver_id, receiver_id FROM assignments WHERE game_id = ?")
      .bind(gameId)
      .all<{ giver_id: number; receiver_id: number }>();
    return new Map(r.results.map((x) => [x.giver_id, x.receiver_id]));
  }

  // --- состояние диалога -----------------------------------------------
  async getState(userId: number): Promise<{ state: string; data: any } | null> {
    const r = await this.d
      .prepare("SELECT state, data FROM user_state WHERE user_id = ?")
      .bind(userId)
      .first<{ state: string; data: string }>();
    return r ? { state: r.state, data: JSON.parse(r.data) } : null;
  }
  async setState(userId: number, state: string, data: unknown = {}): Promise<void> {
    await this.d
      .prepare("INSERT OR REPLACE INTO user_state(user_id, state, data) VALUES (?,?,?)")
      .bind(userId, state, JSON.stringify(data))
      .run();
  }
  async clearState(userId: number): Promise<void> {
    await this.d.prepare("DELETE FROM user_state WHERE user_id = ?").bind(userId).run();
  }
}
