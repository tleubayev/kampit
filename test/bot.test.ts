import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { Bot } from '../src/bot.ts';

test('group stake choice creates one room and a new referral credits its inviter once', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store);
  const bot = new Bot('test:token', 'Kampit_robot', 'play', engine);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  bot.call = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length }; };
  const group = { message_id: 1, chat: { id: -100, type: 'group' }, from: { id: 1, first_name: 'Ali' }, text: '/battle' };
  await bot.handle({ update_id: 1, message: group });
  assert.equal(store.active('-100'), undefined);
  assert.equal(sent.at(-1)!.method, 'sendMessage');
  await bot.handle({ update_id: 2, callback_query: { id: 'callback', from: group.from, message: group, data: 'stake:50' } });
  const battle = store.active('-100')!;
  assert.equal(battle.stake, 50);
  assert.equal(battle.creator_user_id, '1');
  assert.equal(store.account('1')!.balance, 1000);
  const link = store.account('1')!.referral_code;
  const invite = { message_id: 2, chat: { id: 2, type: 'private' }, from: { id: 2, first_name: 'Dana' }, text: '/start ref_' + link };
  await bot.handle({ update_id: 3, message: invite });
  await bot.handle({ update_id: 4, message: invite });
  assert.equal(store.account('1')!.balance, 1100);
  assert.equal(store.account('2')!.balance, 1000);
  store.close();
});

test('battle requests are limited to three per group per minute', async () => {
  const store = new Store(':memory:');
  const bot = new Bot('test:token', 'Kampit_robot', 'play', new Engine(store));
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  bot.call = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length }; };
  const message = { message_id: 1, chat: { id: -200, type: 'group' }, from: { id: 1, first_name: 'Ali' }, text: '/battle' };
  for (let update_id = 1; update_id <= 5; update_id++) await bot.handle({ update_id, message });
  const texts = sent.filter(item => item.method === 'sendMessage').map(item => String(item.body.text));
  assert.equal(texts.filter(text => text.startsWith('Choose the XP stake')).length, 3);
  assert.equal(texts.filter(text => text.startsWith('Too many battle requests')).length, 1);
  store.close();
});
