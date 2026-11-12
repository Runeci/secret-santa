import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Result, D1Stmt } from "../../src/db";

/** Тестовая замена D1 на node:sqlite с тем же интерфейсом (prepare/bind/first/all/run/batch). */
export function createD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));

  const make = (sql: string, params: unknown[] = []): D1Stmt & { exec(): D1Result } => ({
    bind: (...v: unknown[]) => make(sql, v),
    first: async () => ((db.prepare(sql).get(...(params as any[])) as any) ?? null),
    all: async () => ({
      results: db.prepare(sql).all(...(params as any[])) as any[],
      meta: { changes: 0, last_row_id: 0 },
    }),
    run: async () => make(sql, params).exec(),
    exec() {
      const r = db.prepare(sql).run(...(params as any[]));
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });

  return {
    prepare: (sql) => make(sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as any).exec() as D1Result);
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
