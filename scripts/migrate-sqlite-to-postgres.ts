import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const sourcePath = process.env.DATABASE_PATH || './battle.sqlite';
const targetUrl = process.env.POSTGRES_MIGRATION_URL || '';
if (!targetUrl) throw new Error('POSTGRES_MIGRATION_URL is required');

const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
sqlite.exec('BEGIN');
const pg = postgres(targetUrl, { max: 1, prepare: false, idle_timeout: 5 });
const schema = await readFile(new URL('../db/postgres-schema.sql', import.meta.url), 'utf8');

const tables = [
  'battles', 'accounts', 'players', 'result_deliveries', 'stats', 'app_meta',
  'pay_wallets', 'paid_battles', 'pay_faucets', 'pay_transfers', 'pay_intents',
  'pay_withdrawals', 'processed_updates'
] as const;

function sqliteRows(table: string) {
  const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return exists ? sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[] : [];
}

await pg.begin(async tx => {
  await tx.unsafe(schema);
  for (const table of [...tables].reverse()) await tx.unsafe(`TRUNCATE TABLE ${table} CASCADE`);
  for (const table of tables) {
    const rows = sqliteRows(table);
    if (!rows.length) continue;
    const normalized = rows.map((row, index) => table === 'players' ? { ...row, joined_at: index } : row);
    const columns = Object.keys(normalized[0]);
    await tx`INSERT INTO ${tx(table)} ${tx(normalized, columns)}`;
  }
  await tx`INSERT INTO schema_migrations(version,applied_at) VALUES('sqlite-import-v1',${Date.now()}) ON CONFLICT(version) DO UPDATE SET applied_at=EXCLUDED.applied_at`;
});

for (const table of tables) {
  const source = sqliteRows(table).length;
  const [target] = await pg.unsafe<{ count: string }[]>(`SELECT COUNT(*)::text AS count FROM ${table}`);
  if (Number(target.count) !== source) throw new Error(`${table}: source=${source}, target=${target.count}`);
}
const sourceBalance = Number((sqlite.prepare('SELECT COALESCE(SUM(balance),0) AS total FROM accounts').get() as { total: number }).total);
const [targetBalance] = await pg<{ total: string }[]>`SELECT COALESCE(SUM(balance),0)::text AS total FROM accounts`;
if (Number(targetBalance.total) !== sourceBalance) throw new Error(`Account balance mismatch: source=${sourceBalance}, target=${targetBalance.total}`);

console.log(`PostgreSQL migration validated: ${tables.length} tables, ${sourceBalance} total XP`);
sqlite.close();
await pg.end();
