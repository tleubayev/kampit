import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store, type Battle, type Side } from './store.ts';
import type { Quote } from './price.ts';

export const MAX_PLAYERS = 100;
export class GameError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export class Engine extends EventEmitter {
  store: Store;
  constructor(store: Store) { super(); this.store = store; }
  create(chatId: string, stake: number, creatorUserId: string, now = Date.now(), parentId: string | null = null): Battle {
    if (!Number.isSafeInteger(stake) || stake < 10) throw new GameError('Stake must be at least 10 XP');
    const existing = this.store.active(chatId);
    if (existing) return existing;
    const id = randomBytes(8).toString('hex');
    this.store.db.prepare('INSERT INTO battles(id,chat_id,status,created_at,parent_id,stake,creator_user_id) VALUES(?,?,?,?,?,?,?)').run(id, chatId, 'lobby', now, parentId, stake, creatorUserId);
    const battle = this.store.get(id)!;
    this.emit('change', battle);
    return battle;
  }
  rematch(id: string, userId: string, now = Date.now()): Battle {
    const battle = this.require(id);
    if (!['finished', 'void'].includes(battle.status)) throw new GameError('Battle is still in progress');
    if (!this.store.players(id).some(p => p.user_id === userId)) throw new GameError('Only a player can start a rematch', 403);
    if (battle.successor_id) return this.require(battle.successor_id);
    const next = this.create(battle.chat_id, battle.stake || 10, userId, now, id);
    this.store.db.prepare('UPDATE battles SET successor_id=? WHERE id=?').run(next.id, id);
    return next;
  }
  require(id: string): Battle {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new GameError('Invalid battle', 404);
    const battle = this.store.get(id);
    if (!battle) throw new GameError('Battle not found', 404);
    return battle;
  }
  join(id: string, userId: string, name: string) {
    const battle = this.require(id);
    if (battle.status !== 'lobby') throw new GameError('Lobby is closed');
    const clean = name.trim().slice(0, 40) || 'Player';
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.store.db.prepare('SELECT 1 FROM players WHERE battle_id=? AND user_id=?').get(id, userId);
      if (!existing) {
        const count = (this.store.db.prepare('SELECT COUNT(*) AS count FROM players WHERE battle_id=?').get(id) as { count: number }).count;
        if (count >= MAX_PLAYERS) throw new GameError(`Battle is full (${MAX_PLAYERS} players)`, 409);
      }
      this.store.ensureAccount(userId, clean);
      this.store.db.prepare('INSERT INTO players(battle_id,user_id,name) VALUES(?,?,?) ON CONFLICT(battle_id,user_id) DO UPDATE SET name=excluded.name').run(id, userId, clean);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.emit('change', battle);
  }
  ready(id: string, userId: string, now = Date.now()) {
    const battle = this.require(id);
    const player = this.store.db.prepare('SELECT ready FROM players WHERE battle_id=? AND user_id=?').get(id, userId) as { ready: number } | undefined;
    if (!player) throw new GameError('Join the lobby first');
    if (player.ready) return;
    if (battle.status !== 'lobby') throw new GameError('Lobby is closed');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const debited = this.store.db.prepare('UPDATE accounts SET balance=balance-? WHERE user_id=? AND balance>=?').run(battle.stake, userId, battle.stake);
      if (!debited.changes) throw new GameError(`You need ${battle.stake} XP to ready up`);
      this.store.db.prepare('UPDATE players SET ready=1 WHERE battle_id=? AND user_id=?').run(id, userId);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    const players = this.store.players(id);
    if (players.length >= 2 && players.every(p => p.ready)) {
      this.store.db.prepare("UPDATE battles SET status='countdown',countdown_at=? WHERE id=? AND status='lobby'").run(now + 3000, id);
    }
    this.emit('change', this.require(id));
  }
  predict(id: string, userId: string, side: Side, now = Date.now()) {
    const battle = this.require(id);
    if (battle.status !== 'live' || !battle.lock_at || now >= battle.lock_at) throw new GameError('Prediction window is closed');
    if (side !== 'LONG' && side !== 'SHORT') throw new GameError('Invalid prediction');
    const result = this.store.db.prepare('UPDATE players SET prediction=? WHERE battle_id=? AND user_id=? AND prediction IS NULL').run(side, id, userId);
    if (!result.changes) throw new GameError('Already predicted or not in battle');
    this.emit('change', battle);
  }
  tick(now: number, quote: Quote | null) {
    for (const battle of this.store.staleLobbies(now)) this.void(battle.id);
    for (const battle of this.store.pending()) {
      if (battle.status === 'countdown' && battle.countdown_at! <= now) {
        if (!quote || now - quote.at > 5000) continue;
        this.store.db.prepare("UPDATE battles SET status='live',start_at=?,lock_at=?,end_at=?,start_price=? WHERE id=? AND status='countdown'")
          .run(quote.at, quote.at + 10000, quote.at + 60000, quote.price, battle.id);
        this.emit('change', this.require(battle.id));
      } else if (battle.status === 'live' && battle.end_at! <= now) {
        if (now - battle.end_at! > 15000) {
          this.void(battle.id);
        } else if (quote && quote.at >= battle.end_at! && now - quote.at <= 5000) {
          this.resolve(battle.id, quote);
        }
      }
    }
  }
  resolve(id: string, quote: Quote) {
    const battle = this.require(id);
    if (battle.status !== 'live' || quote.at < battle.end_at!) throw new GameError('Battle cannot be resolved yet');
    const outcome: Side | 'HOUSE' = quote.price > battle.start_price! ? 'LONG' : quote.price < battle.start_price! ? 'SHORT' : 'HOUSE';
    const players = this.store.players(id);
    const entrants = players.filter(p => p.ready);
    const winners = entrants.filter(p => p.prediction === outcome);
    const refund = outcome !== 'HOUSE' && winners.length === 0;
    const pool = entrants.length * battle.stake;
    const shares = new Map<string, number>();
    if (refund) for (const p of entrants) shares.set(p.user_id, battle.stake);
    else if (outcome !== 'HOUSE') winners.forEach((p, i) => shares.set(p.user_id, Math.floor(pool / winners.length) + (i < pool % winners.length ? 1 : 0)));
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare("UPDATE battles SET status='finished',end_at=?,end_price=?,outcome=? WHERE id=? AND status='live'")
        .run(quote.at, quote.price, outcome, id);
      for (const player of entrants) {
        const payout = shares.get(player.user_id) || 0;
        if (payout) this.store.db.prepare('UPDATE accounts SET balance=balance+? WHERE user_id=?').run(payout, player.user_id);
        if (!player.prediction && refund) continue;
        const win = player.prediction === outcome;
        const loss = !win;
        const xp = payout - (player.ready ? battle.stake : 0);
        this.store.db.prepare(`INSERT INTO stats(chat_id,user_id,name,wins,losses,ties,streak,xp) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(chat_id,user_id) DO UPDATE SET name=excluded.name,wins=wins+excluded.wins,losses=losses+excluded.losses,ties=ties+excluded.ties,streak=CASE WHEN excluded.wins=1 THEN streak+1 ELSE 0 END,xp=xp+excluded.xp`)
          .run(battle.chat_id, player.user_id, player.name, win ? 1 : 0, loss ? 1 : 0, 0, win ? 1 : 0, xp);
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.emit('resolved', this.require(id));
    this.emit('change', this.require(id));
  }
  void(id: string) {
    const battle = this.require(id);
    if (battle.status === 'void') return;
    if (!['lobby', 'countdown', 'live'].includes(battle.status)) throw new GameError('Battle already finished');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare("UPDATE battles SET status='void' WHERE id=?").run(id);
      for (const player of this.store.players(id)) if (player.ready && battle.stake) {
        this.store.db.prepare('UPDATE accounts SET balance=balance+? WHERE user_id=?').run(battle.stake, player.user_id);
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.emit('resolved', this.require(id));
    this.emit('change', this.require(id));
  }
  snapshot(id: string) {
    const battle = this.require(id);
    return { battle, players: this.store.players(id), leaderboard: this.store.leaderboard(battle.chat_id) };
  }
}
