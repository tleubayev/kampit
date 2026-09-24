import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.ts';
import { Engine, GameError } from './engine.ts';
import { CoinbasePriceFeed } from './price.ts';
import { verifyInitData, type TelegramIdentity } from './auth.ts';
import { Bot } from './bot.ts';
import { SlidingWindowRateLimiter } from './rate-limit.ts';

if (existsSync('.env')) loadEnvFile('.env');
const token = process.env.BOT_TOKEN || '';
const username = process.env.BOT_USERNAME || '';
const shortName = process.env.MINI_APP_SHORT_NAME || '';
const appUrl = process.env.APP_URL || '';
const webhookSecret = process.env.WEBHOOK_SECRET || '';
if (!token || !username || !shortName || !appUrl || !webhookSecret || webhookSecret.length < 16) {
  console.error('Set BOT_TOKEN, BOT_USERNAME, MINI_APP_SHORT_NAME, APP_URL and WEBHOOK_SECRET (16+ chars).'); process.exit(1);
}
const store = new Store(process.env.DATABASE_PATH || './battle.sqlite', 'UTC');
store.grantDaily();
store.db.exec('CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY);');
const engine = new Engine(store);
const feed = new CoinbasePriceFeed();
const bot = new Bot(token, username, shortName, engine);
const sessions = new Map<string, { identity: TelegramIdentity; expires: number }>();
const streams = new Map<string, Set<{ res: ServerResponse; userId: string }>>();
const pendingUpdates = new Map<number, Promise<void>>();
const delivering = new Set<string>();
const apiLimiter = new SlidingWindowRateLimiter();
const actionLimiter = new SlidingWindowRateLimiter();
const sessionLimiter = new SlidingWindowRateLimiter();

function enforceLimit(limiter: SlidingWindowRateLimiter, key: string, limit: number, windowMs = 60_000) {
  const result = limiter.take(key, limit, windowMs);
  if (!result.allowed) throw new GameError(`Too many requests. Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.`, 429);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
}
function cookie(req: IncomingMessage) { return /(?:^|; )session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; }
function identity(req: IncomingMessage) {
  const key = cookie(req); const session = key && sessions.get(key);
  if (!session || session.expires < Date.now()) throw new GameError('Please reopen the Mini App in Telegram', 401);
  return session.identity;
}
async function body(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 16384) throw new GameError('Request too large', 413); }
  try { return JSON.parse(text || '{}') as Record<string, unknown>; } catch { throw new GameError('Invalid JSON'); }
}
function view(id: string, userId: string) {
  const data = engine.snapshot(id);
  const now = Date.now();
  return { ...data, players: data.players.map(p => ({ ...p, prediction: data.battle.status === 'live' && now < data.battle.lock_at! && p.user_id !== userId ? null : p.prediction })),
    me: store.stats(data.battle.chat_id, userId), account: store.account(userId), quote: feed.fresh(now), chart: feed.history, serverNow: now };
}
function broadcast(id: string) {
  for (const client of streams.get(id) || []) {
    try { client.res.write(`data: ${JSON.stringify(view(id, client.userId))}\n\n`); } catch { client.res.end(); }
  }
}
engine.on('change', battle => broadcast(battle.id));
async function deliverResult(id: string) {
  if (delivering.has(id)) return;
  delivering.add(id);
  try {
    await bot.result(engine.require(id));
    store.db.prepare('INSERT OR IGNORE INTO result_deliveries(battle_id,sent_at) VALUES(?,?)').run(id, Date.now());
  } catch (error) { console.error('Result post:', error); }
  finally { delivering.delete(id); }
}
engine.on('resolved', battle => void deliverResult(battle.id));
feed.start();
function scheduleDaily() {
  const now = Date.now();
  const nextMidnight = Math.floor(now / 86400000) * 86400000 + 86400000;
  setTimeout(() => { store.grantDaily(); for (const id of streams.keys()) broadcast(id); scheduleDaily(); }, nextMidnight - now);
}
scheduleDaily();
setInterval(() => { engine.tick(Date.now(), feed.fresh()); for (const id of streams.keys()) broadcast(id); }, 1000);
setInterval(() => { for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key); }, 60000);
setInterval(() => {
  const rows = store.db.prepare("SELECT id FROM battles WHERE status IN ('finished','void') AND id NOT IN (SELECT battle_id FROM result_deliveries)").all() as { id: string }[];
  for (const row of rows) void deliverResult(row.id);
}, 5000);

const publicDir = resolve('public');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', appUrl);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') { json(res, 200, { ok: true, priceFresh: !!feed.fresh() }); return; }
    if (req.method === 'GET' && path === '/admin/metrics') {
      if (req.headers.authorization !== `Bearer ${webhookSecret}`) throw new GameError('Forbidden', 403);
      const count = (sql: string) => (store.db.prepare(sql).get() as { count: number }).count;
      json(res, 200, {
        uniquePlayers: count('SELECT COUNT(DISTINCT user_id) AS count FROM players'),
        accounts: count('SELECT COUNT(*) AS count FROM accounts'),
        totalBalance: count('SELECT COALESCE(SUM(balance),0) AS count FROM accounts'),
        groupNetXp: count('SELECT COALESCE(SUM(xp),0) AS count FROM stats'),
        groups: count('SELECT COUNT(DISTINCT chat_id) AS count FROM battles'),
        battles: count('SELECT COUNT(*) AS count FROM battles'),
        completedBattles: count("SELECT COUNT(*) AS count FROM battles WHERE status = 'finished'"),
      }); return;
    }
    if (req.method === 'POST' && path === '/telegram/webhook') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) throw new GameError('Forbidden', 403);
      const update = await body(req) as any;
      if (!Number.isSafeInteger(update.update_id)) throw new GameError('Invalid update');
      const seen = store.db.prepare('SELECT 1 FROM processed_updates WHERE update_id=?').get(update.update_id);
      if (!seen) {
        let task = pendingUpdates.get(update.update_id);
        if (!task) {
          task = bot.handle(update).then(() => { store.db.prepare('INSERT OR IGNORE INTO processed_updates(update_id) VALUES(?)').run(update.update_id); });
          pendingUpdates.set(update.update_id, task);
        }
        try { await task; } finally { pendingUpdates.delete(update.update_id); }
      }
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && (path === '/' || path === '/app.js' || path === '/style.css' || path === '/kampit-logo.svg')) {
      const file = path === '/' ? 'index.html' : path.slice(1);
      const content = await readFile(resolve(publicDir, file));
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); res.end(content); return;
    }
    if (req.method === 'POST' && path === '/api/session') {
      const data = await body(req);
      const verified = verifyInitData(String(data.initData || ''), token);
      const userId = String(verified.user.id);
      enforceLimit(sessionLimiter, userId, 10);
      store.ensureAccount(userId, [verified.user.first_name, verified.user.last_name].filter(Boolean).join(' '));
      const key = randomBytes(32).toString('hex');
      sessions.set(key, { identity: verified, expires: Date.now() + 86400000 });
      res.setHeader('set-cookie', `session=${key}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${appUrl.startsWith('https:') ? '; Secure' : ''}`);
      json(res, 200, { user: verified.user, startParam: verified.startParam }); return;
    }
    if (path.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== new URL(appUrl).origin) throw new GameError('Wrong origin', 403);
      const actor = identity(req);
      const actorId = String(actor.user.id);
      enforceLimit(apiLimiter, actorId, 60);
      if (req.method === 'GET' && path === '/api/me') {
        const account = store.account(String(actor.user.id))!;
        const referralCount = (store.db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE referred_by=?').get(account.user_id) as { count: number }).count;
        json(res, 200, { account, referralCount, referralLink: `https://t.me/${username}?start=ref_${account.referral_code}` }); return;
      }
      const parts = path.split('/').filter(Boolean);
      if (parts[1] !== 'battles' || !parts[2]) throw new GameError('Not found', 404);
      const id = parts[2];
      if (req.method === 'POST') enforceLimit(actionLimiter, actorId, 10);
      if (req.method === 'GET' && parts.length === 3) { json(res, 200, view(id, String(actor.user.id))); return; }
      if (req.method === 'GET' && parts[3] === 'events') {
        engine.require(id);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const client = { res, userId: String(actor.user.id) };
        if (!streams.has(id)) streams.set(id, new Set());
        streams.get(id)!.add(client);
        res.write(`data: ${JSON.stringify(view(id, client.userId))}\n\n`);
        req.on('close', () => { streams.get(id)?.delete(client); if (!streams.get(id)?.size) streams.delete(id); }); return;
      }
      if (req.method === 'POST' && parts[3] === 'join') {
        engine.join(id, String(actor.user.id), [actor.user.first_name, actor.user.last_name].filter(Boolean).join(' ')); json(res, 200, view(id, String(actor.user.id))); return;
      }
      if (req.method === 'POST' && parts[3] === 'ready') { engine.ready(id, String(actor.user.id)); json(res, 200, view(id, String(actor.user.id))); return; }
      if (req.method === 'POST' && parts[3] === 'start') { engine.startNow(id, String(actor.user.id)); json(res, 200, view(id, String(actor.user.id))); return; }
      if (req.method === 'POST' && parts[3] === 'predict') {
        const data = await body(req);
        engine.predict(id, String(actor.user.id), data.side as any); json(res, 200, view(id, String(actor.user.id))); return;
      }
      if (req.method === 'POST' && parts[3] === 'rematch') {
        const next = engine.rematch(id, String(actor.user.id));
        if (!next.message_id) void bot.card(next).catch(error => console.error('Rematch card:', error));
        json(res, 200, { id: next.id, url: bot.link(next.id) }); return;
      }
      throw new GameError('Not found', 404);
    }
    throw new GameError('Not found', 404);
  } catch (error) {
    const status = error instanceof GameError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) {
      if (status === 429) res.setHeader('retry-after', '60');
      json(res, status, { error: error instanceof Error ? error.message : 'Server error' });
    } else res.end();
  }
});
const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`SOL Quick Battle listening on ${port}`));
void bot.setup(appUrl, webhookSecret).then(() => console.log('Telegram webhook configured')).catch(error => console.error('Telegram setup:', error));
