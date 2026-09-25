import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';

test('dashboard reports aggregate activity without identity rows', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const store = new Store(':memory:');
  const engine = new Engine(store);
  const finished = engine.create('group-1', 25, '1', now - 86400000);
  engine.join(finished.id, '1', 'Ali'); engine.join(finished.id, '2', 'Dana');
  engine.ready(finished.id, '1', now - 86399000); engine.ready(finished.id, '2', now - 86399000);
  store.db.prepare("UPDATE battles SET status='finished',outcome='HOUSE' WHERE id=?").run(finished.id);
  const active = engine.create('group-2', 10, '1', now);
  engine.join(active.id, '1', 'Ali');
  const metrics = store.dashboardMetrics(now);
  assert.equal(metrics.users, 2);
  assert.equal(metrics.groups, 2);
  assert.equal(metrics.battles, 2);
  assert.equal(metrics.activeBattles, 1);
  assert.equal(metrics.completedBattles, 1);
  assert.equal(metrics.averagePlayers, 1.5);
  assert.equal(metrics.maxPlayers, 2);
  assert.equal(metrics.burnedXp, 50);
  assert.equal(metrics.gamesByDay.reduce((sum, day) => sum + day.games, 0), 2);
  assert.equal('user_id' in metrics, false);
  store.close();
});
