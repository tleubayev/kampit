import postgres, { type Sql } from 'postgres';
import { readFile } from 'node:fs/promises';

export type PgExecutor = {
  rows<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  one<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T | undefined>;
  run(query: string, params?: unknown[]): Promise<number>;
};

export function postgresPlaceholders(query: string) {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
}

function executor(sql: Sql): PgExecutor {
  return {
    async rows(query, params = []) { return await sql.unsafe(postgresPlaceholders(query), params as never[]) as never; },
    async one(query, params = []) { return (await sql.unsafe(postgresPlaceholders(query), params as never[]))[0] as never; },
    async run(query, params = []) { return (await sql.unsafe(postgresPlaceholders(query), params as never[])).count; }
  };
}

export class PostgresDatabase implements PgExecutor {
  private sql: Sql;
  private base: PgExecutor;
  constructor(url: string) {
    if (!url) throw new Error('DATABASE_URL is required for PostgreSQL');
    this.sql = postgres(url, { max: 10, prepare: true, idle_timeout: 20, connect_timeout: 10 });
    this.base = executor(this.sql);
  }
  rows<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params: unknown[] = []) { return this.base.rows<T>(query, params); }
  one<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params: unknown[] = []) { return this.base.one<T>(query, params); }
  run(query: string, params: unknown[] = []) { return this.base.run(query, params); }
  async initialize() {
    const schema = await readFile(new URL('../db/postgres-schema.sql', import.meta.url), 'utf8');
    await this.sql.unsafe(schema);
  }
  async transaction<T>(work: (tx: PgExecutor) => Promise<T>) { return this.sql.begin(sql => work(executor(sql))); }
  async locked<T>(namespace: number, key: string, work: (tx: PgExecutor) => Promise<T>) {
    return this.sql.begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(${namespace}, hashtext(${key}))`;
      return work(executor(sql));
    });
  }
  async health() { const row = await this.one<{ ok: number }>('SELECT 1 AS ok'); return row?.ok === 1; }
  async close() { await this.sql.end({ timeout: 5 }); }
}
