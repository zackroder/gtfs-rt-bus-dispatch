import type { Database, Statement } from 'better-sqlite3';

// better-sqlite3 re-parses and re-plans SQL on every .prepare() call, and the engine's hot
// paths (terminal queries, arrival lookups, fact recording) re-run the same statements on
// every refresh cycle and every vehicle position. Memoizing per connection by SQL text
// removes that repeated cost without changing semantics. Statements are schema-keyed, so
// they stay valid across static data reloads and never need invalidation.
const cache = new WeakMap<Database, Map<string, Statement>>();

export function prepared(db: Database, sql: string): Statement {
  let bySql = cache.get(db);
  if (!bySql) {
    bySql = new Map();
    cache.set(db, bySql);
  }
  let statement = bySql.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    bySql.set(sql, statement);
  }
  return statement;
}
