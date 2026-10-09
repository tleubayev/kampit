import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store, type Battle, type Side } from './store.ts';
import type { Quote } from './price.ts';

export const MAX_PLAYERS = 100;
export const MAX_PAID_PLAYERS = 10;
export const MAX_PAID_STAKE_MINOR = 20_000_000;
export const LOBBY_READY_MS = 30_000;
export const LOBBY_MAX_MS = 5 * 60_000;
const COUNTDOWN_MS = 3_000;
export class GameError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export class Engine extends EventEmitter {
  store: Store;
  constructor(store: Store) { super(); this.store = store; }
  create(chatId: string, stake: number, creatorUserId: string, now = Date.now(), parentId: string | null = null): Battle {
    if (!Number.isSafeInteger(stake) || stake < 10) throw new GameError('Stake must be at least 10 XP');
    let existing = this.store.active(chatId);
    if (existing?.status === 'lobby') {
      this.advanceLobby(existing, now);
      existing = this.store.active(chatId);
    }
    if (existing) return existing;
    const id = randomBytes(8).toString('hex');
    this.store.db.prepare('INSERT INTO battles(id,chat_id,status,created_at,parent_id,stake,creator_user_id) VALUES(?,?,?,?,?,?,?)').run(id, chatId, 'lobby', now, parentId, stake, creatorUserId);
    const battle = this.store.get(id)!;
    this.emit('change', battle);
    return battle;
  }
  createPaid(chatId: string, stakeMinor: number, creatorUserId: string, now = Date.now()): Battle {
    if (!Number.isSafeInteger(stakeMinor) || stakeMinor < 100_000 || stakeMinor > MAX_PAID_STAKE_MINOR || !Number.isSafeInteger(stakeMinor * MAX_PAID_PLAYERS)) throw new GameError('Test stake must be between 0.10 and 20.00 USDC');
    const existing = this.store.active(chatId); if (existing) return existing;
    const id = randomBytes(8).toString('hex');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('INSERT INTO battles(id,chat_id,status,created_at,stake,creator_user_id) VALUES(?,?,?,?,0,?)').run(id, chatId, 'lobby', now, creatorUserId);
      this.store.db.prepare('INSERT INTO paid_battles(battle_id,stake_minor) VALUES(?,?)').run(id, stakeMinor);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    const battle = this.require(id); this.emit('change', battle); return battle;
  }
  rematch(id: string, userId: string, now = Date.now()): Battle {
    const battle = this.require(id);
    if (!['finished', 'void'].includes(battle.status)) throw new GameError('Battle is still in progress');
    if (!this.store.players(id).some(p => p.user_id === userId)) throw new GameError('Only a player can start a rematch', 403);
    if (battle.successor_id) return this.require(battle.successor_id);
    const paid = this.store.paidBattle(id);
    const next = paid ? this.createPaid(battle.chat_id, paid.stake_minor, userId, now) : this.create(battle.chat_id, battle.stake || 10, userId, now, id);
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
        const limit = this.store.paidBattle(id) ? MAX_PAID_PLAYERS : MAX_PLAYERS;
        if (count >= limit) throw new GameError(`Battle is full (${limit} players)`, 409);
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
      this.store.db.prepare('UPDATE battles SET lobby_deadline=COALESCE(lobby_deadline,?) WHERE id=? AND status=\'lobby\'')
        .run(Math.min(now + LOBBY_READY_MS, battle.created_at + LOBBY_MAX_MS), id);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.emit('change', this.require(id));
  }
  readyPaid(id: string, userId: string, now = Date.now()) {
    const battle = this.require(id);
    if (!this.store.paidBattle(id)) throw new GameError('This is not a USDC test battle');
    const player = this.store.db.prepare('SELECT ready FROM players WHERE battle_id=? AND user_id=?').get(id, userId) as { ready: number } | undefined;
    if (!player) throw new GameError('Join the lobby first');
    if (player.ready) return;
    if (battle.status !== 'lobby') throw new GameError('Lobby is closed');
    const result = this.store.db.prepare("UPDATE players SET ready=1 WHERE battle_id=? AND user_id=? AND ready=0 AND ?='lobby'").run(id, userId, battle.status);
    if (!result.changes) throw new GameError('Could not ready player');
    if (this.readyCount(id) >= 2) {
      this.store.db.prepare("UPDATE battles SET lobby_deadline=COALESCE(lobby_deadline,?) WHERE id=? AND status='lobby'").run(Math.min(now + LOBBY_READY_MS, battle.created_at + LOBBY_MAX_MS), id);
    }
    this.emit('change', this.require(id));
  }
  startNow(id: string, userId: string, now = Date.now()) {
    const battle = this.require(id);
    if (battle.status !== 'lobby') throw new GameError('Lobby is closed');
    if (battle.creator_user_id !== userId) throw new GameError('Only the room creator can start early', 403);
    if (this.readyCount(id) < 2) throw new GameError('At least 2 ready players are required');
    this.beginCountdown(id, now);
  }
  predict(id: string, userId: string, side: Side, now = Date.now()) {
    const battle = this.require(id);
    if (battle.status !== 'live' || !battle.lock_at || now >= battle.lock_at) throw new GameError('Prediction window is closed');
    if (side !== 'LONG' && side !== 'SHORT') throw new GameError('Invalid prediction');
    const result = this.store.db.prepare('UPDATE players SET prediction=? WHERE battle_id=? AND user_id=? AND ready=1 AND prediction IS NULL').run(side, id, userId);
    if (!result.changes) throw new GameError('Already predicted or not ready for this battle');
    this.emit('change', battle);
  }
  tick(now: number, quote: Quote | null) {
    for (const battle of this.store.lobbies()) this.advanceLobby(battle, now);
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
  private readyCount(id: string) {
    return (this.store.db.prepare('SELECT COUNT(*) AS count FROM players WHERE battle_id=? AND ready=1').get(id) as { count: number }).count;
  }
  private beginCountdown(id: string, now: number) {
    const result = this.store.db.prepare("UPDATE battles SET status='countdown',countdown_at=? WHERE id=? AND status='lobby'").run(now + COUNTDOWN_MS, id);
    if (result.changes) this.emit('change', this.require(id));
  }
  private advanceLobby(battle: Battle, now: number) {
    if (battle.status !== 'lobby') return;
    const hardExpired = battle.created_at + LOBBY_MAX_MS <= now;
    const readyExpired = battle.lobby_deadline !== null && battle.lobby_deadline <= now;
    if (!hardExpired && !readyExpired) return;
    if (readyExpired && this.readyCount(battle.id) >= 2) this.beginCountdown(battle.id, now);
    else this.void(battle.id);
  }
  resolve(id: string, quote: Quote) {
    const battle = this.require(id);
    if (battle.status !== 'live' || quote.at < battle.end_at!) throw new GameError('Battle cannot be resolved yet');
    const outcome: Side | 'HOUSE' = quote.price > battle.start_price! ? 'LONG' : quote.price < battle.start_price! ? 'SHORT' : 'HOUSE';
    const players = this.store.players(id);
    const entrants = players.filter(p => p.ready);
    const winners = entrants.filter(p => p.prediction === outcome);
    const refund = outcome !== 'HOUSE' && winners.length === 0;
    const paid = this.store.paidBattle(id);
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
        if (!paid && payout) this.store.db.prepare('UPDATE accounts SET balance=balance+? WHERE user_id=?').run(payout, player.user_id);
        if (!player.prediction && refund) continue;
        const win = player.prediction === outcome;
        const loss = !win;
        const xp = paid ? 0 : payout - (player.ready ? battle.stake : 0);
        this.store.db.prepare(`INSERT INTO stats(chat_id,user_id,name,wins,losses,ties,streak,xp) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(chat_id,user_id) DO UPDATE SET name=excluded.name,wins=stats.wins+excluded.wins,losses=stats.losses+excluded.losses,ties=stats.ties+excluded.ties,streak=CASE WHEN excluded.wins=1 THEN stats.streak+1 ELSE 0 END,xp=stats.xp+excluded.xp`)
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
      for (const player of this.store.players(id)) if (player.ready && battle.stake && !this.store.paidBattle(id)) {
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
