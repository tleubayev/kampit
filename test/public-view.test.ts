import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicAccount, publicBattle, publicPlayers, publicStats } from '../src/public-view.ts';
import type { Account, Battle, Player } from '../src/store.ts';

test('public API views omit Telegram user and group identifiers', () => {
  const battle = { id: 'abcdef0123456789', chat_id: '-100123', status: 'lobby', created_at: 1, lobby_deadline: 31_000, countdown_at: null, start_at: null, lock_at: null, end_at: null, start_price: null, end_price: null, outcome: null, message_id: 99, parent_id: null, successor_id: null, stake: 10, creator_user_id: '123' } as Battle;
  const players = [{ battle_id: battle.id, user_id: '123', name: 'Ali', ready: 1, prediction: null }] as Player[];
  const account = { user_id: '123', name: 'Ali', balance: 990, referral_code: 'secret-code', referred_by: '456', last_daily_date: '2026-09-25' } as Account;
  const stats = { user_id: '123', name: 'Ali', wins: 1, losses: 0, ties: 0, streak: 1, xp: 10 };
  const output = {
    battle: publicBattle(battle, '123'),
    players: publicPlayers(players, battle, '123', 2),
    account: publicAccount(account),
    me: publicStats(stats),
  };
  assert.equal(output.battle.isCreator, true);
  assert.equal(output.players[0].isYou, true);
  assert.deepEqual(output.account, { balance: 990 });
  const serialized = JSON.stringify(output);
  for (const privateKey of ['user_id', 'creator_user_id', 'chat_id', 'message_id', 'referral_code', 'referred_by', 'last_daily_date']) {
    assert.equal(serialized.includes(privateKey), false);
  }
  assert.equal(serialized.includes('-100123'), false);
});
