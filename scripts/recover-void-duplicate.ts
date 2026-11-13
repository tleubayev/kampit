import { Store } from '../src/store.ts';
import { MIN_STAKE_NANO, TonGramService, payConfigFromEnv } from '../src/pay-mode.ts';

const [battleId, duplicatedUser, otherUser, sourceA, sourceB] = process.argv.slice(2);
if (![battleId, duplicatedUser, otherUser, sourceA, sourceB].every(Boolean)) throw new Error('Pass battle, duplicate user, other user, and both duplicate source hashes');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const store = new Store(':memory:', 'UTC', process.env.DATABASE_URL);
const config = payConfigFromEnv({ ...process.env, PAY_MODE_ENABLED: 'true', PAY_MODE_PUBLIC: 'true' });
const service = new TonGramService(store, config);
try {
  await service.initialize();
  const confirmed = await service.confirmStake(battleId, duplicatedUser, MIN_STAKE_NANO);
  await service.confirmStake(battleId, otherUser, MIN_STAKE_NANO);
  const duplicateSource = [sourceA, sourceB].find(source => source !== confirmed);
  if (!duplicateSource) throw new Error('Could not distinguish the confirmed and duplicate deposits');
  const refunds = await Promise.all([
    service.pay(duplicatedUser, battleId, 'refund', MIN_STAKE_NANO),
    service.pay(otherUser, battleId, 'refund', MIN_STAKE_NANO),
    service.recoverDuplicate(battleId, duplicatedUser, duplicateSource, MIN_STAKE_NANO),
  ]);
  store.db.prepare("UPDATE paid_battles SET settlement_status='settled' WHERE battle_id=?").run(battleId);
  console.log(JSON.stringify({ battleId, refunds, totalRefundedNano: MIN_STAKE_NANO * 3 }));
} finally { store.close(); }
