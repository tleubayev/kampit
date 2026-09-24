import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export type Status = 'lobby' | 'countdown' | 'live' | 'finished' | 'void';
export type Side = 'LONG' | 'SHORT';
export type Battle = { id: string; chat_id: string; status: Status; created_at: number; lobby_deadline: number | null; countdown_at: number | null; start_at: number | null; lock_at: number | null; end_at: number | null; start_price: number | null; end_price: number | null; outcome: Side | 'HOUSE' | 'TIE' | null; message_id: number | null; parent_id: string | null; successor_id: string | null; stake: number; creator_user_id: string | null };
export type Player = { battle_id: string; user_id: string; name: string; ready: number; prediction: Side | null };
export type Account = { user_id: string; name: string; balance: number; referral_code: string; referred_by: string | null; last_daily_date: string };

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
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!this.db.prepare("SELECT 1 FROM app_meta WHERE key='xp_reset_v2'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const today = dailyDate(Date.now(), this.timeZone);
        this.db.exec('CREATE TABLE IF NOT EXISTS stats_before_xp_reset AS SELECT * FROM stats');
        const former = this.db.prepare('SELECT user_id, MAX(name) AS name FROM (SELECT user_id,name FROM players UNION ALL SELECT user_id,name FROM stats) GROUP BY user_id').all() as { user_id: string; name: string }[];
        const insert = this.db.prepare('INSERT OR IGNORE INTO accounts(user_id,name,balance,referral_code,last_daily_date) VALUES(?,?,?,?,?)');
        for (const user of former) insert.run(user.user_id, user.name, 1000, randomBytes(8).toString('hex'), today);
        this.db.exec('UPDATE stats SET xp=0');
        this.db.exec("UPDATE battles SET status='void' WHERE stake=0 AND status IN ('lobby','countdown','live')");
        this.db.prepare("INSERT INTO app_meta(key,value) VALUES('xp_reset_v2',?)").run(today);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  account(userId: string) { return this.db.prepare('SELECT * FROM accounts WHERE user_id=?').get(userId) as Account | undefined; }
  ensureAccount(userId: string, name: string, now = Date.now()) {
    const clean = name.trim().slice(0, 40) || 'Player';
    this.db.prepare('INSERT OR IGNORE INTO accounts(user_id,name,balance,referral_code,last_daily_date) VALUES(?,?,?,?,?)')
      .run(userId, clean, 1000, randomBytes(8).toString('hex'), dailyDate(now, this.timeZone));
    this.db.prepare('UPDATE accounts SET name=? WHERE user_id=?').run(clean, userId);
    return this.account(userId)!;
  }
  claimReferral(userId: string, name: string, code: string, now = Date.now()) {
    if (this.account(userId)) return false;
    const referrer = this.db.prepare('SELECT user_id FROM accounts WHERE referral_code=?').get(code) as { user_id: string } | undefined;
    if (!referrer || referrer.user_id === userId) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO accounts(user_id,name,balance,referral_code,referred_by,last_daily_date) VALUES(?,?,?,?,?,?)')
        .run(userId, name.trim().slice(0, 40) || 'Player', 1000, randomBytes(8).toString('hex'), referrer.user_id, dailyDate(now, this.timeZone));
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
  players(id: string) { return this.db.prepare('SELECT * FROM players WHERE battle_id=? ORDER BY rowid').all(id) as Player[]; }
  active(chatId: string) { return this.db.prepare("SELECT * FROM battles WHERE chat_id=? AND status IN ('lobby','countdown','live') ORDER BY created_at DESC LIMIT 1").get(chatId) as Battle | undefined; }
  pending() { return this.db.prepare("SELECT * FROM battles WHERE status IN ('countdown','live')").all() as Battle[]; }
  lobbies() { return this.db.prepare("SELECT * FROM battles WHERE status='lobby'").all() as Battle[]; }
  leaderboard(chatId: string) { return this.db.prepare('SELECT user_id,name,wins,losses,ties,streak,xp FROM stats WHERE chat_id=? ORDER BY xp DESC,wins DESC LIMIT 20').all(chatId); }
  stats(chatId: string, userId: string) { return this.db.prepare('SELECT user_id,name,wins,losses,ties,streak,xp FROM stats WHERE chat_id=? AND user_id=?').get(chatId, userId); }
  close() { this.db.close(); }
}
