import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine, GameError } from '../src/engine.ts';

function fixture() { const store=new Store(':memory:'); const engine=new Engine(store); return {store,engine}; }
test('two ready players trigger one synchronized round and lock picks', () => {
  const {store,engine}=fixture();const battle=engine.create('-100',1000);
  engine.join(battle.id,'1','Ali');engine.join(battle.id,'2','Dana');engine.ready(battle.id,'1',1000);
  assert.equal(engine.require(battle.id).status,'lobby');engine.ready(battle.id,'2',1000);
  assert.equal(engine.require(battle.id).countdown_at,4000);
  engine.tick(3999,{price:100,at:3999,sourceTime:''});assert.equal(engine.require(battle.id).status,'countdown');
  engine.tick(4000,{price:100,at:4000,sourceTime:''});
  assert.equal(engine.require(battle.id).end_at,64000);assert.equal(engine.require(battle.id).lock_at,14000);
  engine.predict(battle.id,'1','LONG',5000);engine.predict(battle.id,'2','SHORT',13999);
  assert.throws(()=>engine.predict(battle.id,'2','LONG',14000),GameError);
  engine.tick(64000,{price:101,at:64000,sourceTime:''});
  assert.equal(engine.require(battle.id).outcome,'LONG');
  assert.deepEqual({...store.stats('-100','1')},{user_id:'1',name:'Ali',wins:1,losses:0,ties:0,streak:1,xp:100});
  assert.equal((store.stats('-100','2') as any).losses,1);
  engine.tick(65000,{price:102,at:65000,sourceTime:''});assert.equal((store.stats('-100','1') as any).xp,100);
  store.close();
});
test('ties award 25 XP, rematch is idempotent, stale prices void the round', () => {
  const {store,engine}=fixture();const first=engine.create('g',1000);
  engine.join(first.id,'1','A');engine.join(first.id,'2','B');engine.ready(first.id,'1',1000);engine.ready(first.id,'2',1000);
  engine.tick(4000,{price:100,at:4000,sourceTime:''});engine.predict(first.id,'1','LONG',5000);engine.predict(first.id,'2','SHORT',5000);
  engine.tick(64000,{price:100,at:64000,sourceTime:''});
  assert.equal(engine.require(first.id).outcome,'TIE');assert.equal((store.stats('g','1') as any).xp,25);
  const second=engine.rematch(first.id,'1',65000);assert.equal(engine.rematch(first.id,'2',65001).id,second.id);
  assert.throws(()=>engine.rematch(first.id,'3'),GameError);
  engine.join(second.id,'1','A');engine.join(second.id,'2','B');engine.ready(second.id,'1',66000);engine.ready(second.id,'2',66000);
  engine.tick(69000,{price:100,at:69000,sourceTime:''});engine.tick(144001,null);
  assert.equal(engine.require(second.id).status,'void');assert.equal((store.stats('g','1') as any).xp,25);
  store.close();
});
