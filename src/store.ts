import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export type Status = 'lobby' | 'countdown' | 'live' | 'finished' | 'void';
export type Side = 'LONG' | 'SHORT';
export type Battle = { id: string; chat_id: string; status: Status; created_at: number; lobby_deadline: number | null; countdown_at: number | null; start_at: number | null; lock_at: number | null; end_at: number | null; start_price: number | null; end_price: number | null; outcome: Side | 'HOUSE' | 'TIE' | null; message_id: number | null; parent_id: string | null; successor_id: string | null; stake: number; creator_user_id: string | null };
export type Player = { battle_id: string; user_id: string; name: string; ready: number; prediction: Side | null };
export type Account = { user_id: string; name: string; balance: number; referral_code: string; referred_by: string | null; last_daily_date: string; created_at: number; last_seen_at: number };

export function dailyDate(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (part: string) => parts.find(p => p.type === part)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function daysBetween(from: string, to: string) { return Math.max(0, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000)); }

export class Store {
  db: DatabaseSync;
  timeZone: string;
  constructor(path: string, timeZone = 'UTC') {
    this.timeZone = timeZone;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS battles (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, countdown_at INTEGER, start_at INTEGER, lock_at INTEGER, end_at INTEGER, start_price REAL, end_price REAL, outcome TEXT, message_id INTEGER, parent_id TEXT UNIQUE, successor_id TEXT);
      CREATE INDEX IF NOT EXISTS battles_chat ON battles(chat_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS players (battle_id TEXT NOT NULL REFERENCES battles(id), user_id TEXT NOT NULL, name TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, prediction TEXT, PRIMARY KEY(battle_id,user_id));
      CREATE TABLE IF NOT EXISTS result_deliveries (battle_id TEXT PRIMARY KEY REFERENCES battles(id), sent_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS stats (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, ties INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id,user_id));`);
    const columns = this.db.prepare('PRAGMA table_info(battles)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'stake')) this.db.exec('ALTER TABLE battles ADD COLUMN stake INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(c => c.name === 'creator_user_id')) this.db.exec('ALTER TABLE battles ADD COLUMN creator_user_id TEXT');
    if (!columns.some(c => c.name === 'lobby_deadline')) this.db.exec('ALTER TABLE battles ADD COLUMN lobby_deadline INTEGER');
    this.db.exec(`CREATE TABLE IF NOT EXISTS accounts (user_id TEXT PRIMARY KEY, name TEXT NOT NULL, balance INTEGER NOT NULL CHECK(balance >= 0), referral_code TEXT NOT NULL UNIQUE, referred_by TEXT, last_daily_date TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pay_wallets (user_id TEXT PRIMARY KEY REFERENCES accounts(user_id), address TEXT NOT NULL UNIQUE, encrypted_secret TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS paid_battles (battle_id TEXT PRIMARY KEY REFERENCES battles(id), stake_minor INTEGER NOT NULL CHECK(stake_minor >= 100000), settlement_status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS pay_faucets (user_id TEXT PRIMARY KEY, amount_minor INTEGER NOT NULL, signature TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pay_transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, battle_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('stake','payout','refund')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), signature TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, UNIQUE(battle_id,user_id,kind));
      CREATE TABLE IF NOT EXISTS pay_intents (battle_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('stake','payout','refund')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','signed','confirmed')), signature TEXT UNIQUE, raw_transaction TEXT, blockhash TEXT, last_valid_block_height INTEGER, attempt INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(battle_id,user_id,kind));`);
    const intentSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pay_intents'").get() as { sql: string }).sql;
    if (!intentSql.includes("'house'")) this.db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE pay_intents RENAME TO pay_intents_legacy;
      CREATE TABLE pay_intents (battle_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('stake','payout','refund','withdrawal','house')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','signed','confirmed','failed')), signature TEXT UNIQUE, raw_transaction TEXT, blockhash TEXT, last_valid_block_height INTEGER, attempt INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(battle_id,user_id,kind));
      INSERT INTO pay_intents SELECT * FROM pay_intents_legacy; DROP TABLE pay_intents_legacy;
      ALTER TABLE pay_transfers RENAME TO pay_transfers_legacy;
      CREATE TABLE pay_transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, battle_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('stake','payout','refund','withdrawal','house')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), signature TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, UNIQUE(battle_id,user_id,kind));
      INSERT INTO pay_transfers SELECT * FROM pay_transfers_legacy; DROP TABLE pay_transfers_legacy; COMMIT;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS pay_withdrawals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recipient TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS pay_withdrawals_user_date ON pay_withdrawals(user_id,created_at DESC);`);
    const withdrawalColumns = this.db.prepare('PRAGMA table_info(pay_withdrawals)').all() as { name: string }[];
    if (!withdrawalColumns.some(c => c.name === 'approval_status')) this.db.exec("ALTER TABLE pay_withdrawals ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'auto' CHECK(approval_status IN ('auto','pending','approved','rejected'))");
    if (!withdrawalColumns.some(c => c.name === 'approved_at')) this.db.exec('ALTER TABLE pay_withdrawals ADD COLUMN approved_at INTEGER');
    if (!withdrawalColumns.some(c => c.name === 'approved_by')) this.db.exec('ALTER TABLE pay_withdrawals ADD COLUMN approved_by TEXT');
    const payWalletColumns = this.db.prepare('PRAGMA table_info(pay_wallets)').all() as { name: string }[];
    if (!payWalletColumns.some(c => c.name === 'privy_wallet_id')) this.db.exec('ALTER TABLE pay_wallets ADD COLUMN privy_wallet_id TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS pay_wallets_privy_id ON pay_wallets(privy_wallet_id) WHERE privy_wallet_id IS NOT NULL');
    const accountColumns = this.db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[];
    if (!accountColumns.some(c => c.name === 'created_at')) this.db.exec('ALTER TABLE accounts ADD COLUMN created_at INTEGER');
    if (!accountColumns.some(c => c.name === 'last_seen_at')) this.db.exec('ALTER TABLE accounts ADD COLUMN last_seen_at INTEGER');
    if (!this.db.prepare("SELECT 1 FROM app_meta WHERE key='xp_reset_v2'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const today = dailyDate(Date.now(), this.timeZone);
        this.db.exec('CREATE TABLE IF NOT EXISTS stats_before_xp_reset AS SELECT * FROM stats');
        const former = this.db.prepare('SELECT user_id, MAX(name) AS name FROM (SELECT user_id,name FROM players UNION ALL SELECT user_id,name FROM stats) GROUP BY user_id').all() as { user_id: string; name: string }[];
        const insert = this.db.prepare('INSERT OR IGNORE INTO accounts(user_id,name,balance,referral_code,last_daily_date,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)');
        const now = Date.now();
        for (const user of former) insert.run(user.user_id, user.name, 1000, randomBytes(8).toString('hex'), today, now, now);
        this.db.exec('UPDATE stats SET xp=0');
        this.db.exec("UPDATE battles SET status='void' WHERE stake=0 AND status IN ('lobby','countdown','live')");
        this.db.prepare("INSERT INTO app_meta(key,value) VALUES('xp_reset_v2',?)").run(today);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    const migrationNow = Date.now();
    this.db.prepare(`UPDATE accounts SET created_at=COALESCE((SELECT MIN(b.created_at) FROM players p JOIN battles b ON b.id=p.battle_id WHERE p.user_id=accounts.user_id),?) WHERE created_at IS NULL`).run(migrationNow);
    this.db.prepare(`UPDATE accounts SET last_seen_at=COALESCE((SELECT MAX(b.created_at) FROM players p JOIN battles b ON b.id=p.battle_id WHERE p.user_id=accounts.user_id),created_at,?) WHERE last_seen_at IS NULL`).run(migrationNow);
  }
  account(userId: string) { return this.db.prepare('SELECT * FROM accounts WHERE user_id=?').get(userId) as Account | undefined; }
  ensureAccount(userId: string, name: string, now = Date.now()) {
    const clean = name.trim().slice(0, 40) || 'Player';
    this.db.prepare('INSERT OR IGNORE INTO accounts(user_id,name,balance,referral_code,last_daily_date,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)')
      .run(userId, clean, 1000, randomBytes(8).toString('hex'), dailyDate(now, this.timeZone), now, now);
    this.db.prepare('UPDATE accounts SET name=?,last_seen_at=? WHERE user_id=?').run(clean, now, userId);
    return this.account(userId)!;
  }
  claimReferral(userId: string, name: string, code: string, now = Date.now()) {
    if (this.account(userId)) return false;
    const referrer = this.db.prepare('SELECT user_id FROM accounts WHERE referral_code=?').get(code) as { user_id: string } | undefined;
    if (!referrer || referrer.user_id === userId) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO accounts(user_id,name,balance,referral_code,referred_by,last_daily_date,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(userId, name.trim().slice(0, 40) || 'Player', 1000, randomBytes(8).toString('hex'), referrer.user_id, dailyDate(now, this.timeZone), now, now);
      this.db.prepare('UPDATE accounts SET balance=balance+100 WHERE user_id=?').run(referrer.user_id);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  grantDaily(now = Date.now()) {
    const today = dailyDate(now, this.timeZone);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.db.prepare('SELECT user_id,last_daily_date FROM accounts WHERE last_daily_date<?').all(today) as { user_id: string; last_daily_date: string }[]) {
        const days = daysBetween(row.last_daily_date, today);
        if (days) this.db.prepare('UPDATE accounts SET balance=balance+?,last_daily_date=? WHERE user_id=?').run(days * 100, today, row.user_id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrateChat(oldId: string, newId: string) {
    if (oldId === newId) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT * FROM stats WHERE chat_id=?').all(oldId) as { user_id: string; name: string; wins: number; losses: number; ties: number; streak: number; xp: number }[];
      const merge = this.db.prepare(`INSERT INTO stats(chat_id,user_id,name,wins,losses,ties,streak,xp) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(chat_id,user_id) DO UPDATE SET wins=stats.wins+excluded.wins,losses=stats.losses+excluded.losses,ties=stats.ties+excluded.ties,streak=MAX(stats.streak,excluded.streak),xp=stats.xp+excluded.xp`);
      for (const row of rows) merge.run(newId, row.user_id, row.name, row.wins, row.losses, row.ties, row.streak, row.xp);
      this.db.prepare('DELETE FROM stats WHERE chat_id=?').run(oldId);
      this.db.prepare('UPDATE battles SET chat_id=? WHERE chat_id=?').run(newId, oldId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string) { return this.db.prepare('SELECT * FROM battles WHERE id=?').get(id) as Battle | undefined; }
  paidBattle(id: string) { return this.db.prepare('SELECT battle_id,stake_minor,settlement_status FROM paid_battles WHERE battle_id=?').get(id) as { battle_id: string; stake_minor: number; settlement_status: string } | undefined; }
  players(id: string) { return this.db.prepare('SELECT * FROM players WHERE battle_id=? ORDER BY rowid').all(id) as Player[]; }
  active(chatId: string) { return this.db.prepare("SELECT * FROM battles WHERE chat_id=? AND status IN ('lobby','countdown','live') ORDER BY created_at DESC LIMIT 1").get(chatId) as Battle | undefined; }
  pending() { return this.db.prepare("SELECT * FROM battles WHERE status IN ('countdown','live')").all() as Battle[]; }
  lobbies() { return this.db.prepare("SELECT * FROM battles WHERE status='lobby'").all() as Battle[]; }
  leaderboard(chatId: string) { return this.db.prepare('SELECT user_id,name,wins,losses,ties,streak,xp FROM stats WHERE chat_id=? ORDER BY xp DESC,wins DESC LIMIT 20').all(chatId); }
  stats(chatId: string, userId: string) { return this.db.prepare('SELECT user_id,name,wins,losses,ties,streak,xp FROM stats WHERE chat_id=? AND user_id=?').get(chatId, userId); }
  dashboardMetrics(now = Date.now()) {
    const value = (sql: string, ...params: unknown[]) => Number((this.db.prepare(sql).get(...params) as { value: number | null }).value || 0);
    const since24h = now - 86400000, since7d = now - 7 * 86400000, since30d = now - 30 * 86400000;
    const dailyRows = this.db.prepare("SELECT date(created_at/1000,'unixepoch') AS day,COUNT(*) AS games FROM battles WHERE created_at>=? GROUP BY day ORDER BY day").all(now - 13 * 86400000) as { day: string; games: number }[];
    const daily = new Map(dailyRows.map(row => [row.day, Number(row.games)]));
    const gamesByDay = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(now - (13 - index) * 86400000).toISOString().slice(0, 10);
      return { date, games: daily.get(date) || 0 };
    });
    return {
      users: value('SELECT COUNT(*) AS value FROM accounts'),
      active24h: value('SELECT COUNT(*) AS value FROM accounts WHERE last_seen_at>=?', since24h),
      active7d: value('SELECT COUNT(*) AS value FROM accounts WHERE last_seen_at>=?', since7d),
      active30d: value('SELECT COUNT(*) AS value FROM accounts WHERE last_seen_at>=?', since30d),
      groups: value('SELECT COUNT(DISTINCT chat_id) AS value FROM battles'),
      battles: value('SELECT COUNT(*) AS value FROM battles'),
      activeBattles: value("SELECT COUNT(*) AS value FROM battles WHERE status IN ('lobby','countdown','live')"),
      completedBattles: value("SELECT COUNT(*) AS value FROM battles WHERE status='finished'"),
      voidBattles: value("SELECT COUNT(*) AS value FROM battles WHERE status='void'"),
      averagePlayers: Math.round(value('SELECT AVG(player_count) AS value FROM (SELECT COUNT(p.user_id) AS player_count FROM battles b LEFT JOIN players p ON p.battle_id=b.id GROUP BY b.id)') * 10) / 10,
      maxPlayers: value('SELECT COALESCE(MAX(player_count),0) AS value FROM (SELECT COUNT(*) AS player_count FROM players GROUP BY battle_id)'),
      totalXp: value('SELECT COALESCE(SUM(balance),0) AS value FROM accounts'),
      stakedXp: value("SELECT COALESCE(SUM(b.stake),0) AS value FROM battles b JOIN players p ON p.battle_id=b.id AND p.ready=1 WHERE b.status IN ('lobby','countdown','live')"),
      burnedXp: value("SELECT COALESCE(SUM(b.stake),0) AS value FROM battles b JOIN players p ON p.battle_id=b.id AND p.ready=1 WHERE b.status='finished' AND b.outcome='HOUSE'"),
      referrals: value('SELECT COUNT(*) AS value FROM accounts WHERE referred_by IS NOT NULL'),
      resultDeliveryBacklog: value("SELECT COUNT(*) AS value FROM battles WHERE status IN ('finished','void') AND id NOT IN (SELECT battle_id FROM result_deliveries)"),
      gamesByDay,
    };
  }
  close() { this.db.close(); }
}
