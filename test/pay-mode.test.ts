import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { MAX_STAKE_NANO, MIN_STAKE_NANO, TonGramService, payConfigFromEnv, validatePayConfig, type ChainTransfer, type PayConfig, type TonGateway } from '../src/pay-mode.ts';

const phrase = (word: string) => Array(12).fill(word).join(' ');
const address = (digit: string) => Address.parseRaw(`0:${digit.repeat(64)}`).toString({ testOnly: true, bounceable: false });
const roles = { escrow: address('1'), operating: address('2'), treasury: address('3') };
const userWallet = address('4');
const config: PayConfig = { enabled: true, publicAccess: true, network: 'testnet', rpcUrl: 'https://test.invalid', apiKey: 'test-api-key', escrowMnemonic: phrase('escrow'), operatingMnemonic: phrase('operating'), treasuryMnemonic: phrase('treasury'), allowedUsers: new Set() };

class FakeGateway implements TonGateway {
  transfers: ChainTransfer[] = [];
  sends = 0;
  async address(mnemonic: string) { return mnemonic === config.escrowMnemonic ? roles.escrow : mnemonic === config.operatingMnemonic ? roles.operating : roles.treasury; }
  async balance() { return 10_000_000_000; }
  async incoming(to: string) { return this.transfers.filter(item => Address.parse(item.to).equals(Address.parse(to))); }
  async send(_mnemonic: string, to: string, amountNano: number, comment: string) { this.sends++; const hash = `hash-${this.sends}`; this.transfers.push({ hash, from: roles.escrow, to, amountNano, comment }); return hash; }
}

function fixture() { const store = new Store(':memory:'); store.ensureAccount('1', 'Ali'); const gateway = new FakeGateway(); const service = new TonGramService(store, config, gateway); return { store, gateway, service }; }

test('GRAM mode is testnet-only and requires three wallet mnemonics', () => {
  assert.throws(() => payConfigFromEnv({ TON_NETWORK: 'mainnet' } as NodeJS.ProcessEnv), /locked to TON testnet/);
  assert.throws(() => validatePayConfig({ ...config, escrowMnemonic: '' }), /TON_ESCROW_MNEMONIC/);
  assert.throws(() => validatePayConfig({ ...config, apiKey: '' }), /TON_API_KEY/);
  assert.throws(() => validatePayConfig({ ...config, publicAccess: false, allowedUsers: new Set() }), /PAY_MODE_TESTERS/);
  assert.equal(payConfigFromEnv({ PAY_MODE_ENABLED: 'false' } as NodeJS.ProcessEnv).network, 'testnet');
});

test('initialization rejects reused Kampit role wallets', async () => {
  const { store, gateway } = fixture();
  gateway.address = async () => roles.escrow;
  await assert.rejects(() => new TonGramService(store, config, gateway).initialize(), /three different TON wallets/);
  store.close();
});

test('stake intent binds one payment ID to exact wallet, amount, battle and escrow', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  const intent = await service.prepareStake('battle', '1', MIN_STAKE_NANO, userWallet);
  assert.equal(intent.address, roles.escrow); assert.equal(intent.amountNano, String(MIN_STAKE_NANO)); assert.equal(intent.network, '-3'); assert.ok(intent.paymentId); assert.ok(intent.payload);
  gateway.transfers.push({ hash: 'wrong-amount', from: userWallet, to: roles.escrow, amountNano: MIN_STAKE_NANO + 1, comment: `kampit:${intent.paymentId}` });
  await assert.rejects(() => service.confirmStake('battle', '1', MIN_STAKE_NANO), /still confirming/);
  gateway.transfers.push({ hash: 'stake-hash', from: userWallet, to: roles.escrow, amountNano: MIN_STAKE_NANO, comment: `kampit:${intent.paymentId}` });
  assert.equal(await service.confirmStake('battle', '1', MIN_STAKE_NANO), 'stake-hash');
  assert.equal(await service.confirmStake('battle', '1', MIN_STAKE_NANO), 'stake-hash');
  const row = store.db.prepare("SELECT state,signature FROM pay_intents WHERE battle_id='battle' AND user_id='1' AND kind='stake'").get() as any;
  assert.equal(row.state, 'confirmed'); assert.equal(row.signature, 'stake-hash'); store.close();
});

test('stake limits are enforced before a transaction request is created', async () => {
  const { store, service } = fixture(); await service.initialize();
  await assert.rejects(() => service.prepareStake('low', '1', MIN_STAKE_NANO - 1, userWallet), /between 0.10 and 20 GRAM/);
  await assert.rejects(() => service.prepareStake('high', '1', MAX_STAKE_NANO + 1, userWallet), /between 0.10 and 20 GRAM/);
  store.close();
});

test('payout remains idempotent across service restarts', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  store.db.prepare("INSERT INTO pay_wallets(user_id,address,encrypted_secret,created_at) VALUES(?,?,'ton-connect',1) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,encrypted_secret='ton-connect'").run('1', userWallet);
  assert.equal(await service.pay('1', 'battle', 'payout', MIN_STAKE_NANO), 'hash-1');
  const restarted = new TonGramService(store, config, gateway); await restarted.initialize();
  assert.equal(await restarted.pay('1', 'battle', 'payout', MIN_STAKE_NANO), 'hash-1');
  assert.equal(gateway.sends, 1);
  assert.equal(restarted.history('1')[0].amountNano, MIN_STAKE_NANO); store.close();
});

test('house transfers go from escrow to the separate treasury wallet', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  assert.equal(await service.house('battle', MIN_STAKE_NANO), 'hash-1');
  assert.equal(gateway.transfers[0].to, roles.treasury);
  assert.equal(gateway.transfers[0].comment, 'kampit-out:house:battle:house'); store.close();
});

test('paid GRAM readiness never changes XP balances', () => {
  const store = new Store(':memory:'), engine = new Engine(store), battle = engine.createPaid('g', MIN_STAKE_NANO, '1', 1000);
  engine.join(battle.id, '1', 'A'); engine.join(battle.id, '2', 'B');
  const beforeA = store.account('1')!.balance, beforeB = store.account('2')!.balance;
  engine.readyPaid(battle.id, '1', 2000); engine.readyPaid(battle.id, '2', 3000);
  assert.equal(store.account('1')!.balance, beforeA); assert.equal(store.account('2')!.balance, beforeB);
  assert.equal(store.paidBattle(battle.id)?.asset, 'gram'); store.close();
});
