import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.ts';
import { Engine, GameError } from './engine.ts';
import { CoinbasePriceFeed } from './price.ts';
import { verifyInitData, type TelegramIdentity } from './auth.ts';
import { Bot } from './bot.ts';
import { SlidingWindowRateLimiter } from './rate-limit.ts';
import { publicAccount, publicBattle, publicPlayers, publicStats } from './public-view.ts';
import { DevnetUsdcService, payConfigFromEnv, validatePayConfig } from './pay-mode.ts';

if (existsSync('.env')) loadEnvFile('.env');
const token = process.env.BOT_TOKEN || '';
const username = process.env.BOT_USERNAME || '';
const shortName = process.env.MINI_APP_SHORT_NAME || '';
const appUrl = process.env.APP_URL || '';
const webhookSecret = process.env.WEBHOOK_SECRET || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (!token || !username || !shortName || !appUrl || !webhookSecret || webhookSecret.length < 16) {
  console.error('Set BOT_TOKEN, BOT_USERNAME, MINI_APP_SHORT_NAME, APP_URL and WEBHOOK_SECRET (16+ chars).'); process.exit(1);
}
const store = new Store(process.env.DATABASE_PATH || './battle.sqlite', 'UTC');
const payConfig = payConfigFromEnv();
validatePayConfig(payConfig);
const payMode = payConfig.enabled ? new DevnetUsdcService(store, payConfig) : null;
store.grantDaily();
store.db.exec('CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY);');
const engine = new Engine(store);
const feed = new CoinbasePriceFeed();
const bot = new Bot(token, username, shortName, engine, payConfig.allowedUsers);
const sessions = new Map<string, { identity: TelegramIdentity; expires: number }>();
const streams = new Map<string, Set<{ res: ServerResponse; userId: string }>>();
const pendingUpdates = new Map<number, Promise<void>>();
const delivering = new Set<string>();
const apiLimiter = new SlidingWindowRateLimiter();
const actionLimiter = new SlidingWindowRateLimiter();
const sessionLimiter = new SlidingWindowRateLimiter();
let paymentHealth: Awaited<ReturnType<DevnetUsdcService['reconcile']>> | null = null;

function enforceLimit(limiter: SlidingWindowRateLimiter, key: string, limit: number, windowMs = 60_000) {
  const result = limiter.take(key, limit, windowMs);
  if (!result.allowed) throw new GameError(`Too many requests. Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.`, 429);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
}
function sameSecret(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function adminAuthorized(req: IncomingMessage) {
  if (req.headers.authorization === `Bearer ${webhookSecret}`) return true;
  if (!adminPassword || !req.headers.authorization?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    return split >= 0 && decoded.slice(0, split) === 'admin' && sameSecret(decoded.slice(split + 1), adminPassword);
  } catch { return false; }
}
function requireAdmin(req: IncomingMessage, res: ServerResponse) {
  if (adminAuthorized(req)) return true;
  res.setHeader('www-authenticate', 'Basic realm="Kampit Admin", charset="UTF-8"');
  json(res, 401, { error: 'Admin login required' });
  return false;
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
  return {
    battle: publicBattle(data.battle, userId, store.paidBattle(id)),
    players: publicPlayers(data.players, data.battle, userId, now),
    leaderboard: (data.leaderboard as any[]).map(row => publicStats(row)),
    me: publicStats(store.stats(data.battle.chat_id, userId) as any),
    account: publicAccount(store.account(userId)!),
    quote: feed.fresh(now), chart: feed.history, serverNow: now,
  };
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
async function settlePaidBattle(id: string) {
  if (!payMode) return;
  const paid = store.paidBattle(id); if (!paid || paid.settlement_status === 'settled') return;
  const battle = engine.require(id); if (!['finished', 'void'].includes(battle.status)) return;
  const entrants = store.players(id).filter(player => player.ready);
  if (battle.status === 'void') {
    for (const player of entrants) await payMode.pay(player.user_id, id, 'refund', paid.stake_minor);
  } else if (battle.outcome !== 'HOUSE') {
    const winners = entrants.filter(player => player.prediction === battle.outcome);
    if (!winners.length) for (const player of entrants) await payMode.pay(player.user_id, id, 'refund', paid.stake_minor);
    else {
      const pool = entrants.length * paid.stake_minor;
      for (let index = 0; index < winners.length; index++) await payMode.pay(winners[index].user_id, id, 'payout', Math.floor(pool / winners.length) + (index < pool % winners.length ? 1 : 0));
    }
  }
  store.db.prepare("UPDATE paid_battles SET settlement_status='settled' WHERE battle_id=?").run(id); broadcast(id);
}
engine.on('resolved', battle => void settlePaidBattle(battle.id).catch(error => console.error('Test-USDC settlement:', error)));
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
setInterval(() => {
  if (!payMode) return;
  const rows = store.db.prepare("SELECT pb.battle_id AS id FROM paid_battles pb JOIN battles b ON b.id=pb.battle_id WHERE pb.settlement_status='pending' AND b.status IN ('finished','void')").all() as { id: string }[];
  for (const row of rows) void settlePaidBattle(row.id).catch(error => console.error('Test-USDC settlement retry:', error));
}, 10000);
async function reconcilePayments() {
  if (!payMode) return;
  try {
    const next = await payMode.reconcile();
    const changed = JSON.stringify(next.alerts) !== JSON.stringify(paymentHealth?.alerts || []);
    paymentHealth = next;
    if (changed && next.alerts.length) console.error('TREASURY ALERT:', next.alerts.join('; '));
  } catch (error) { console.error('Payment reconciliation worker:', error); }
}
if (payMode) { void reconcilePayments(); setInterval(() => void reconcilePayments(), 30000); }

const publicDir = resolve('public');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', appUrl);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') { json(res, 200, { ok: true, priceFresh: !!feed.fresh() }); return; }
    if (req.method === 'GET' && path === '/admin') {
      if (!requireAdmin(req, res)) return;
      const content = await readFile(resolve(publicDir, 'admin.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(content); return;
    }
    if (req.method === 'GET' && path === '/admin/metrics') {
      if (!requireAdmin(req, res)) return;
      json(res, 200, { ...store.dashboardMetrics(), health: { priceFresh: !!feed.fresh(), connectedPlayers: [...streams.values()].reduce((sum, clients) => sum + clients.size, 0), payments: paymentHealth }, generatedAt: Date.now() }); return;
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
      json(res, 200, { startParam: verified.startParam }); return;
    }
    if (path.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== new URL(appUrl).origin) throw new GameError('Wrong origin', 403);
      const actor = identity(req);
      const actorId = String(actor.user.id);
      enforceLimit(apiLimiter, actorId, 60);
      if (req.method === 'GET' && path === '/api/me') {
        const account = store.account(String(actor.user.id))!;
        const referralCount = (store.db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE referred_by=?').get(account.user_id) as { count: number }).count;
        json(res, 200, { account: publicAccount(account), referralCount, referralLink: `https://t.me/${username}?start=ref_${account.referral_code}` }); return;
      }
      if (req.method === 'GET' && path === '/api/pay') {
        if (!payMode) throw new GameError('Test pay mode is disabled', 404);
        payMode.assertTester(actorId);
        const wallet = await payMode.wallet(actorId);
        json(res, 200, { enabled: true, cluster: 'devnet', currency: 'Circle test USDC', mintAddress: payMode.mint.toBase58(), walletAddress: wallet.address, depositAddress: await payMode.depositAddress(actorId), balanceMinor: await payMode.balanceMinor(actorId), limits: { minWithdrawalMinor: 100_000, maxWithdrawalMinor: 20_000_000, dailyWithdrawalMinor: 100_000_000 } }); return;
      }
      if (req.method === 'GET' && path === '/api/pay/history') {
        if (!payMode) throw new GameError('Test pay mode is disabled', 404);
        json(res, 200, { transactions: payMode.history(actorId) }); return;
      }
      if (req.method === 'POST' && path === '/api/pay/withdrawals') {
        if (!payMode) throw new GameError('Test pay mode is disabled', 404);
        enforceLimit(actionLimiter, actorId, 3, 60000);
        const data = await body(req);
        const signature = await payMode.withdraw(actorId, String(data.requestId || ''), String(data.recipient || ''), Number(data.amountMinor));
        json(res, 200, { signature, balanceMinor: await payMode.balanceMinor(actorId), transactions: payMode.history(actorId) }); return;
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
      if (req.method === 'POST' && parts[3] === 'ready') {
        const paid = store.paidBattle(id);
        if (paid) {
          if (!payMode) throw new GameError('Test pay mode is disabled', 503);
          const player = store.players(id).find(item => item.user_id === actorId);
          if (!player) throw new GameError('Join the lobby first');
          if (!player.ready) await payMode.lockStake(id, actorId, paid.stake_minor);
          engine.readyPaid(id, actorId);
        } else engine.ready(id, actorId);
        json(res, 200, view(id, actorId)); return;
      }
      if (req.method === 'POST' && parts[3] === 'start') { engine.startNow(id, String(actor.user.id)); json(res, 200, view(id, String(actor.user.id))); return; }
      if (req.method === 'POST' && parts[3] === 'predict') {
        const data = await body(req);
        engine.predict(id, String(actor.user.id), data.side as any); json(res, 200, view(id, String(actor.user.id))); return;
      }
      if (req.method === 'POST' && parts[3] === 'rematch') {
        const next = engine.rematch(id, String(actor.user.id));
        if (!next.message_id) void bot.card(next).catch(error => console.error('Rematch card:', error));
        json(res, 200, { id: next.id }); return;
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
