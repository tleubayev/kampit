import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, dailyDate } from '../src/store.ts';
import { Engine, GameError, MAX_PAID_PLAYERS, MAX_PAID_STAKE_MINOR, MAX_PLAYERS } from '../src/engine.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() { const store = new Store(':memory:'); const engine = new Engine(store); return { store, engine }; }
const quote = (price: number, at: number) => ({ price, at, sourceTime: '' });

test('battle accepts 100 players and rejects the 101st', () => {
  const { store, engine } = fixture();
  const battle = engine.create('g', 10, '1', 1000);
  for (let i = 1; i <= MAX_PLAYERS; i++) engine.join(battle.id, String(i), `Player ${i}`);
  assert.equal(store.players(battle.id).length, 100);
  assert.throws(() => engine.join(battle.id, '101', 'Player 101'), (error: unknown) => {
    assert.equal((error as GameError).status, 409);
    assert.match((error as Error).message, /full \(100 players\)/);
    return true;
  });
  engine.join(battle.id, '100', 'Renamed Player');
  assert.equal(store.players(battle.id).length, 100);
  assert.equal(store.players(battle.id).at(-1)?.name, 'Renamed Player');
  store.close();
});

test('paid battle accepts 10 players and rejects the 11th', () => {
  const store = new Store(':memory:'), engine = new Engine(store), battle = engine.createPaid('g', 100_000, '1');
  for (let i = 1; i <= MAX_PAID_PLAYERS; i++) engine.join(battle.id, String(i), `Player ${i}`);
  assert.equal(store.players(battle.id).length, 10);
  assert.throws(() => engine.join(battle.id, '11', 'Player 11'), /full \(10 players\)/);
  store.close();
});

test('stake is fixed, reserved on ready, and winners split the full pool', () => {
  const { store, engine } = fixture();
  assert.throws(() => engine.create('g', 9, '1', 1000), GameError);
  const battle = engine.create('g', 15, '1', 1000);
  engine.join(battle.id, '1', 'Ali'); engine.join(battle.id, '2', 'Dana'); engine.join(battle.id, '3', 'Max');
  engine.ready(battle.id, '1', 1000); engine.ready(battle.id, '1', 1000);
  engine.ready(battle.id, '2', 1000); engine.ready(battle.id, '3', 1000);
  assert.equal(store.account('1')!.balance, 985);
  engine.startNow(battle.id, '1', 1000);
  assert.equal(engine.require(battle.id).countdown_at, 4000);
  engine.tick(4000, quote(100, 4000));
  engine.predict(battle.id, '1', 'LONG', 5000); engine.predict(battle.id, '2', 'LONG', 5000); engine.predict(battle.id, '3', 'SHORT', 5000);
  assert.throws(() => engine.predict(battle.id, '3', 'LONG', 14000), GameError);
  engine.tick(64000, quote(101, 64000));
  assert.equal(engine.require(battle.id).outcome, 'LONG');
  assert.equal(store.account('1')!.balance, 1008);
  assert.equal(store.account('2')!.balance, 1007);
  assert.equal(store.account('3')!.balance, 985);
  assert.equal((store.stats('g', '1') as any).xp, 8);
  assert.equal((store.stats('g', '3') as any).losses, 1);
  engine.tick(65000, quote(102, 65000));
  assert.equal(store.account('1')!.balance, 1008);
  store.close();
});

test('flat-price rounds burn every stake; no winning picks and void rounds refund', () => {
  const { store, engine } = fixture();
  const first = engine.create('g', 50, '1', 1000);
  engine.join(first.id, '1', 'A'); engine.join(first.id, '2', 'B');
  engine.ready(first.id, '1', 1000); engine.ready(first.id, '2', 1000);
  engine.startNow(first.id, '1', 1000);
  engine.tick(4000, quote(100, 4000)); engine.predict(first.id, '1', 'LONG', 5000); engine.predict(first.id, '2', 'SHORT', 5000);
  engine.tick(64000, quote(100, 64000));
  assert.equal(engine.require(first.id).outcome, 'HOUSE');
  assert.equal(store.account('1')!.balance, 950); assert.equal(store.account('2')!.balance, 950);
  assert.equal((store.stats('g', '1') as { losses: number; xp: number }).losses, 1);
  assert.equal((store.stats('g', '1') as { losses: number; xp: number }).xp, -50);
  engine.tick(65000, quote(100, 65000));
  assert.equal(store.account('1')!.balance, 950);
  const second = engine.rematch(first.id, '1', 65000);
  assert.equal(second.stake, 50); assert.equal(engine.rematch(first.id, '2', 65001).id, second.id);
  engine.join(second.id, '1', 'A'); engine.join(second.id, '2', 'B');
  engine.ready(second.id, '1', 66000); engine.ready(second.id, '2', 66000);
  engine.startNow(second.id, '1', 66000);
  engine.tick(69000, quote(100, 69000)); engine.predict(second.id, '1', 'LONG', 70000); engine.predict(second.id, '2', 'LONG', 70000);
  engine.tick(129000, quote(99, 129000));
  assert.equal(store.account('1')!.balance, 950); assert.equal(store.account('2')!.balance, 950);
  const third = engine.rematch(second.id, '1', 130000);
  engine.join(third.id, '1', 'A'); engine.join(third.id, '2', 'B');
  engine.ready(third.id, '1', 130000); engine.ready(third.id, '2', 130000);
  engine.startNow(third.id, '1', 130000);
  engine.tick(133000, quote(100, 133000)); engine.tick(208001, null);
  assert.equal(engine.require(third.id).status, 'void');
  assert.equal(store.account('1')!.balance, 950); assert.equal(store.account('2')!.balance, 950);
  store.close();
});

test('new accounts get 1000 XP, daily credit is UTC and idempotent, referrals award once', () => {
  const { store } = fixture();
  const before = Date.parse('2026-09-17T23:59:59Z');
  const after = Date.parse('2026-09-18T00:00:00Z');
  assert.equal(dailyDate(before, 'UTC'), '2026-09-17');
  const inviter = store.ensureAccount('1', 'Inviter', before);
  assert.equal(inviter.balance, 1000);
  assert.equal(store.claimReferral('2', 'Friend', inviter.referral_code, before), true);
  assert.equal(store.claimReferral('2', 'Friend', inviter.referral_code, before), false);
  assert.equal(store.claimReferral('1', 'Inviter', inviter.referral_code, before), false);
  assert.equal(store.account('1')!.balance, 1100);
  assert.equal(store.account('2')!.balance, 1000);
  store.grantDaily(after); store.grantDaily(after);
  assert.equal(store.account('1')!.balance, 1200);
  assert.equal(store.account('2')!.balance, 1100);
  store.close();
});

test('insufficient XP cannot ready and expired lobbies refund reserved XP', () => {
  const { store, engine } = fixture();
  const battle = engine.create('g', 1000, '1', 1000);
  engine.join(battle.id, '1', 'A'); engine.join(battle.id, '2', 'B');
  engine.ready(battle.id, '1', 1000);
  assert.equal(store.account('1')!.balance, 0);
  const second = engine.create('g2', 10, '1', 1000);
  engine.join(second.id, '1', 'A');
  assert.throws(() => engine.ready(second.id, '1', 1000), GameError);
  engine.tick(901001, null);
  assert.equal(engine.require(battle.id).status, 'void');
  assert.equal(store.account('1')!.balance, 1000);
  store.close();
});

test('ready window starts with the first ready player and ignores inactive joiners', () => {
  const { store, engine } = fixture();
  const battle = engine.create('g', 25, '1', 1000);
  engine.join(battle.id, '1', 'A'); engine.join(battle.id, '2', 'B'); engine.join(battle.id, '3', 'Inactive');
  engine.ready(battle.id, '1', 1000); engine.ready(battle.id, '2', 5000);
  assert.equal(engine.require(battle.id).lobby_deadline, 31000);
  engine.tick(30999, quote(100, 30999));
  assert.equal(engine.require(battle.id).status, 'lobby');
  engine.tick(31000, quote(100, 31000));
  assert.equal(engine.require(battle.id).status, 'countdown');
  engine.tick(34000, quote(100, 34000));
  assert.throws(() => engine.predict(battle.id, '3', 'LONG', 35000), /not ready/);
  engine.predict(battle.id, '1', 'LONG', 35000); engine.predict(battle.id, '2', 'SHORT', 35000);
  engine.tick(94000, quote(101, 94000));
  assert.equal(store.account('3')!.balance, 1000);
  store.close();
});

test('short lobby refunds one ready player and hard-expired lobby is replaced', () => {
  const { store, engine } = fixture();
  const first = engine.create('g', 50, '1', 1000);
  engine.join(first.id, '1', 'A'); engine.ready(first.id, '1', 1000);
  engine.tick(31000, null);
  assert.equal(engine.require(first.id).status, 'void');
  assert.equal(store.account('1')!.balance, 1000);
  const stale = engine.create('g', 50, '1', 32000);
  const replacement = engine.create('g', 75, '2', 332001);
  assert.notEqual(replacement.id, stale.id);
  assert.equal(engine.require(stale.id).status, 'void');
  assert.equal(replacement.stake, 75);
  store.close();
});

test('only the creator can start early and two ready players are required', () => {
  const { store, engine } = fixture();
  const battle = engine.create('g', 10, '1', 1000);
  engine.join(battle.id, '1', 'A'); engine.join(battle.id, '2', 'B');
  engine.ready(battle.id, '1', 1000);
  assert.throws(() => engine.startNow(battle.id, '1', 1000), /At least 2/);
  engine.ready(battle.id, '2', 1000);
  assert.throws(() => engine.startNow(battle.id, '2', 1000), (error: unknown) => (error as GameError).status === 403);
  engine.startNow(battle.id, '1', 1000);
  assert.equal(engine.require(battle.id).countdown_at, 4000);
  store.close();
});

test('legacy player XP resets once and each existing player gets a 1000 XP account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battle-migration-'));
  const path = join(dir, 'game.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE players (battle_id TEXT,user_id TEXT,name TEXT,ready INTEGER,prediction TEXT);
      CREATE TABLE stats (chat_id TEXT,user_id TEXT,name TEXT,wins INTEGER,losses INTEGER,ties INTEGER,streak INTEGER,xp INTEGER);
      INSERT INTO players VALUES ('old','1','Ali',1,'LONG'),('old','2','Dana',1,'SHORT');
      INSERT INTO stats VALUES ('g','1','Ali',3,2,0,1,350);`);
    old.close();
    let store = new Store(path);
    assert.equal(store.account('1')!.balance, 1000);
    assert.equal(store.account('2')!.balance, 1000);
    assert.equal((store.stats('g', '1') as any).xp, 0);
    assert.equal((store.db.prepare('SELECT xp FROM stats_before_xp_reset').get() as any).xp, 350);
    store.db.prepare('UPDATE accounts SET balance=900 WHERE user_id=?').run('1');
    store.close();
    store = new Store(path);
    assert.equal(store.account('1')!.balance, 900);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrated Telegram groups keep their battles and merged leaderboard', () => {
  const { store, engine } = fixture();
  const battle = engine.create('-123', 10, '1', 1000);
  store.db.prepare('INSERT INTO stats(chat_id,user_id,name,wins,losses,ties,streak,xp) VALUES(?,?,?,?,?,?,?,?)').run('-123', '1', 'Ali', 2, 1, 0, 1, 20);
  store.db.prepare('INSERT INTO stats(chat_id,user_id,name,wins,losses,ties,streak,xp) VALUES(?,?,?,?,?,?,?,?)').run('-100456', '1', 'Ali', 1, 0, 0, 1, 10);
  store.migrateChat('-123', '-100456');
  store.migrateChat('-123', '-100456');
  assert.equal(engine.require(battle.id).chat_id, '-100456');
  assert.equal((store.stats('-100456', '1') as any).wins, 3);
  assert.equal((store.stats('-100456', '1') as any).xp, 30);
  assert.equal(store.stats('-123', '1'), undefined);
  store.close();
});

test('paid battle stake is capped before a room is created', () => {
  const { store, engine } = fixture();
  assert.throws(() => engine.createPaid('g', MAX_PAID_STAKE_MINOR + 1, '1'), /between 0.10 and 20.00/);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM battles').get() as any).count, 0);
  store.close();
});
