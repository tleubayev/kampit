import { DatabaseSync } from 'node:sqlite';

export type Status = 'lobby' | 'countdown' | 'live' | 'finished' | 'void';
export type Side = 'LONG' | 'SHORT';
export type Battle = { id: string; chat_id: string; status: Status; created_at: number; countdown_at: number | null; start_at: number | null; lock_at: number | null; end_at: number | null; start_price: number | null; end_price: number | null; outcome: Side | 'TIE' | null; message_id: number | null; parent_id: string | null; successor_id: string | null };
export type Player = { battle_id: string; user_id: string; name: string; ready: number; prediction: Side | null };

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS battles (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, countdown_at INTEGER, start_at INTEGER, lock_at INTEGER, end_at INTEGER, start_price REAL, end_price REAL, outcome TEXT, message_id INTEGER, parent_id TEXT UNIQUE, successor_id TEXT);
      CREATE INDEX IF NOT EXISTS battles_chat ON battles(chat_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS players (battle_id TEXT NOT NULL REFERENCES battles(id), user_id TEXT NOT NULL, name TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, prediction TEXT, PRIMARY KEY(battle_id,user_id));
      CREATE TABLE IF NOT EXISTS stats (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, ties INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id,user_id));`);
  }
  get(id: string) { return this.db.prepare('SELECT * FROM battles WHERE id=?').get(id) as Battle | undefined; }
  players(id: string) { return this.db.prepare('SELECT * FROM players WHERE battle_id=? ORDER BY rowid').all(id) as Player[]; }
  active(chatId: string) { return this.db.prepare("SELECT * FROM battles WHERE chat_id=? AND status IN ('lobby','countdown','live') ORDER BY created_at DESC LIMIT 1").get(chatId) as Battle | undefined; }
  pending() { return this.db.prepare("SELECT * FROM battles WHERE status IN ('countdown','live')").all() as Battle[]; }
  leaderboard(chatId: string) { return this.db.prepare('SELECT user_id,name,wins,losses,ties,streak,xp FROM stats WHERE chat_id=? ORDER BY xp DESC,wins DESC LIMIT 20').all(chatId); }
  stats(chatId: string, userId: string) { return this.db.prepare('SELECT user_id,name,wins,losses,ties,streak,xp FROM stats WHERE chat_id=? AND user_id=?').get(chatId, userId); }
  close() { this.db.close(); }
}
