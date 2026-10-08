import { parentPort, workerData } from 'node:worker_threads';
import postgres from 'postgres';

const sql = postgres(workerData.url, { max: 1, prepare: false, idle_timeout: 0, connect_timeout: 10 });
const signal = new Int32Array(workerData.shared, 0, 2);
const output = new Uint8Array(workerData.shared, 8);
const numeric = new Set(['created_at','last_seen_at','lobby_deadline','countdown_at','start_at','lock_at','end_at','message_id','stake','balance','wins','losses','ties','streak','xp','stake_minor','amount_minor','updated_at','last_valid_block_height','attempt','approved_at','sent_at','count','value','total','games','player_count']);

function queryText(input: string) {
  let q = input.trim().replace(/^BEGIN IMMEDIATE$/i, 'BEGIN');
  const replaceMeta = /^INSERT OR REPLACE INTO app_meta\(key,value\)/i.test(q);
  q = q.replace(/^INSERT OR REPLACE INTO app_meta\(key,value\)/i, 'INSERT INTO app_meta(key,value)');
  let index = 0;
  q = q.replace(/\?/g, () => `$${++index}`);
  q = q.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
  if (/^INSERT INTO/i.test(q) && /OR IGNORE/i.test(input) && !/ON CONFLICT/i.test(q)) q += ' ON CONFLICT DO NOTHING';
  if (replaceMeta) q += ' ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value';
  q = q.replace(/MAX\(stats\.streak,excluded\.streak\)/gi, 'GREATEST(stats.streak,excluded.streak)');
  q = q.replace(/ORDER BY rowid/gi, 'ORDER BY joined_at');
  q = q.replace(/date\(created_at\/1000,'unixepoch'\)/gi, "to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD')");
  return q;
}
function normalize(row: Record<string, unknown>) {
  for (const [key, value] of Object.entries(row)) if (numeric.has(key) && typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) row[key] = Number(value);
  return row;
}
function respond(value: unknown, error?: unknown) {
  const data = Buffer.from(JSON.stringify(error ? { error: error instanceof Error ? error.message : String(error) } : { value }));
  if (data.length > output.length) throw new Error('PostgreSQL bridge response is too large');
  output.fill(0); output.set(data); Atomics.store(signal, 1, data.length); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
}
parentPort!.on('message', async ({ op, query, params = [] }) => {
  try {
    if (op === 'close') { await sql.end({ timeout: 5 }); respond(true); return; }
    if (op === 'exec') { await sql.unsafe(queryText(query)); respond(true); return; }
    const result = await sql.unsafe(queryText(query), params);
    if (op === 'run') respond({ changes: result.count });
    else if (op === 'get') respond(result[0] ? normalize(result[0]) : undefined);
    else respond(result.map(normalize));
  } catch (error) { respond(undefined, error); }
});
