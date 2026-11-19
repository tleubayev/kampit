import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { MAX_STAKE_NANO, MIN_STAKE_NANO, NANO_GRAM, TonGramService, payConfigFromEnv, validatePayConfig, type ChainCursor, type ChainTransfer, type PayConfig, type TonGateway } from '../src/pay-mode.ts';

const phrase = (word: string) => Array(12).fill(word).join(' ');
const address = (digit: string) => Address.parseRaw(`0:${digit.repeat(64)}`).toString({ testOnly: true, bounceable: false });
const roles = { escrow: address('1'), treasury: address('3') };
const userWallet = address('4');
const config: PayConfig = { enabled: true, publicAccess: true, network: 'testnet', rpcUrl: 'https://test.invalid', apiKey: 'test-api-key', escrowMnemonic: phrase('escrow'), treasuryAddress: roles.treasury, minStakeNano: MIN_STAKE_NANO, maxStakeNano: MAX_STAKE_NANO, reserveNano: 50_000_000, allowedUsers: new Set() };

class FakeGateway implements TonGateway {
  transfers: ChainTransfer[] = [];
  sends = 0;
  balanceNano = 10_000_000_000;
  async address() { return roles.escrow; }
  async balance() { return this.balanceNano; }
  async scan(to: string, _cursor?: ChainCursor) { return { transfers: this.transfers.filter(item => Address.parse(item.to).equals(Address.parse(to)) || Address.parse(item.from).equals(Address.parse(to))).map(item => ({ ...item, direction: Address.parse(item.to).equals(Address.parse(to)) ? 'incoming' as const : 'outgoing' as const })), cursor: this.transfers.length ? { lt: String(this.transfers.length), hash: `cursor-${this.transfers.length}` } : null }; }
  async send(_mnemonic: string, to: string, amountNano: number, comment: string) { this.sends++; const hash = `hash-${this.sends}`; this.transfers.push({ hash, from: roles.escrow, to, amountNano, comment, direction: 'outgoing' }); return hash; }
}

function fixture() { const store = new Store(':memory:'); store.ensureAccount('1', 'Ali'); const gateway = new FakeGateway(); const service = new TonGramService(store, config, gateway); return { store, gateway, service }; }

test('GRAM mode supports isolated testnet and mainnet configurations', () => {
  assert.throws(() => validatePayConfig({ ...config, escrowMnemonic: '' }), /TON_ESCROW_MNEMONIC/);
  assert.throws(() => validatePayConfig({ ...config, treasuryAddress: '' }), /TON_TREASURY_ADDRESS/);
  assert.throws(() => validatePayConfig({ ...config, apiKey: '' }), /TON_API_KEY/);
  assert.throws(() => validatePayConfig({ ...config, publicAccess: false, allowedUsers: new Set() }), /PAY_MODE_TESTERS/);
  assert.equal(payConfigFromEnv({ PAY_MODE_ENABLED: 'false' } as NodeJS.ProcessEnv).network, 'testnet');
  const mainnet = payConfigFromEnv({ PAY_MODE_ENABLED: 'false', TON_NETWORK: 'mainnet' } as NodeJS.ProcessEnv);
  assert.equal(mainnet.network, 'mainnet'); assert.equal(mainnet.rpcUrl, 'https://toncenter.com/api/v2/jsonRPC'); assert.equal(mainnet.maxStakeNano, NANO_GRAM);
  assert.throws(() => payConfigFromEnv({ TON_NETWORK: 'invalid' } as NodeJS.ProcessEnv), /testnet or mainnet/);
});

test('initialization rejects reused Kampit role wallets', async () => {
  const { store, gateway } = fixture();
  await assert.rejects(() => new TonGramService(store, { ...config, treasuryAddress: roles.escrow }, gateway).initialize(), /different TON wallets/);
  store.close();
});

test('stake intent binds one payment ID to exact wallet, amount, battle and escrow', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  const intent = await service.prepareStake('battle', '1', MIN_STAKE_NANO, userWallet);
  assert.equal(intent.address, roles.escrow); assert.equal(intent.amountNano, String(MIN_STAKE_NANO)); assert.equal(intent.network, '-3'); assert.ok(intent.paymentId); assert.ok(intent.payload);
  gateway.transfers.push({ hash: 'wrong-amount', from: userWallet, to: roles.escrow, amountNano: MIN_STAKE_NANO + 1, comment: `kampit:${intent.paymentId}`, direction: 'incoming' });
  await assert.rejects(() => service.confirmStake('battle', '1', MIN_STAKE_NANO), /still confirming/);
  gateway.transfers.push({ hash: 'stake-hash', from: userWallet, to: roles.escrow, amountNano: MIN_STAKE_NANO, comment: `kampit:${intent.paymentId}`, direction: 'incoming' });
  assert.equal(await service.confirmStake('battle', '1', MIN_STAKE_NANO), 'stake-hash');
  assert.equal(await service.confirmStake('battle', '1', MIN_STAKE_NANO), 'stake-hash');
  const row = store.db.prepare("SELECT state,signature FROM pay_intents WHERE battle_id='battle' AND user_id='1' AND kind='stake'").get() as any;
  assert.equal(row.state, 'confirmed'); assert.equal(row.signature, 'stake-hash'); store.close();
});

test('retry discovers the original on-chain stake instead of requesting another payment', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  const intent = await service.prepareStake('retry', '1', MIN_STAKE_NANO, userWallet);
  gateway.transfers.push({ hash: 'already-paid', from: userWallet, to: roles.escrow, amountNano: MIN_STAKE_NANO, comment: `kampit:${intent.paymentId}`, direction: 'incoming' });
  assert.deepEqual(await service.prepareStake('retry', '1', MIN_STAKE_NANO, userWallet), { confirmed: true });
  const row = store.db.prepare("SELECT state,signature FROM pay_intents WHERE battle_id='retry' AND user_id='1' AND kind='stake'").get() as any;
  assert.equal(row.state, 'confirmed'); assert.equal(row.signature, 'already-paid'); store.close();
});

test('an expired intent still recovers a payment that already reached escrow', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  const intent = await service.prepareStake('expired-paid', '1', MIN_STAKE_NANO, userWallet);
  store.db.prepare("UPDATE pay_intents SET last_valid_block_height=1 WHERE battle_id='expired-paid' AND user_id='1' AND kind='stake'").run();
  gateway.transfers.push({ hash: 'late-confirmation', from: userWallet, to: roles.escrow, amountNano: MIN_STAKE_NANO, comment: `kampit:${intent.paymentId}`, direction: 'incoming' });
  assert.equal(await service.confirmStake('expired-paid', '1', MIN_STAKE_NANO), 'late-confirmation'); store.close();
});

test('stake limits are enforced before a transaction request is created', async () => {
  const { store, service } = fixture(); await service.initialize();
  await assert.rejects(() => service.prepareStake('low', '1', MIN_STAKE_NANO - 1, userWallet), /between 0.10 and 20.00 GRAM/);
  await assert.rejects(() => service.prepareStake('high', '1', MAX_STAKE_NANO + 1, userWallet), /between 0.10 and 20.00 GRAM/);
  store.close();
});

test('mainnet stake requests use the TON mainnet chain id and conservative ceiling', async () => {
  const store = new Store(':memory:'); store.ensureAccount('1', 'Ali'); const gateway = new FakeGateway();
  const mainnetConfig = { ...config, network: 'mainnet' as const, maxStakeNano: NANO_GRAM };
  const service = new TonGramService(store, mainnetConfig, gateway); await service.initialize();
  const intent = await service.prepareStake('mainnet', '1', MIN_STAKE_NANO, userWallet); assert.equal(intent.network, '-239');
  await assert.rejects(() => service.prepareStake('too-high', '1', NANO_GRAM + 1, userWallet), /between 0.10 and 1.00 GRAM/); store.close();
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

test('database payment claim prevents two service instances from signing the same payout', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  store.db.prepare("INSERT INTO pay_wallets(user_id,address,encrypted_secret,created_at) VALUES(?,?,'ton-connect',1) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,encrypted_secret='ton-connect'").run('1', userWallet);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalSend = gateway.send.bind(gateway);
  gateway.send = async (...args) => { await gate; return originalSend(...args); };
  const first = service.pay('1', 'claimed', 'payout', MIN_STAKE_NANO);
  await new Promise(resolve => setImmediate(resolve));
  const competing = new TonGramService(store, config, gateway); await competing.initialize();
  await assert.rejects(() => competing.pay('1', 'claimed', 'payout', MIN_STAKE_NANO), /already being processed safely/);
  release();
  assert.equal(await first, 'hash-1');
  assert.equal(gateway.sends, 1); store.close();
});

test('escrow safety includes confirmed player liabilities and pauses new stakes below reserve', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  const engine = new Engine(store), battle = engine.createPaid('safe', MIN_STAKE_NANO, '1');
  const intent = await service.prepareStake(battle.id, '1', MIN_STAKE_NANO, userWallet);
  gateway.transfers.push({ hash: 'liability-stake', from: userWallet, to: roles.escrow, amountNano: MIN_STAKE_NANO, comment: `kampit:${intent.paymentId}`, direction: 'incoming' });
  await service.confirmStake(battle.id, '1', MIN_STAKE_NANO);
  gateway.balanceNano = MIN_STAKE_NANO + config.reserveNano - 1;
  const health = await service.reconcile();
  assert.equal(health.wallets.escrow.obligationsNano, MIN_STAKE_NANO);
  assert.equal(health.wallets.escrow.reserveNano, config.reserveNano);
  assert.equal(health.acceptingPayments, false);
  await assert.rejects(() => service.prepareStake('new-battle', '1', MIN_STAKE_NANO, userWallet), /temporarily paused/);
  store.close();
});

test('house transfers go from escrow to the separate treasury wallet', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  assert.equal(await service.house('battle', MIN_STAKE_NANO), 'hash-1');
  assert.equal(gateway.transfers[0].to, roles.treasury);
  assert.equal(gateway.transfers[0].comment, 'kampit-out:house:battle:house'); store.close();
});

test('duplicate stake recovery is persisted and idempotent', async () => {
  const { store, gateway, service } = fixture(); await service.initialize();
  store.db.prepare("INSERT INTO pay_wallets(user_id,address,encrypted_secret,created_at) VALUES(?,?,'ton-connect',1) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,encrypted_secret='ton-connect'").run('1', userWallet);
  const source = 'a'.repeat(64);
  assert.equal(await service.recoverDuplicate('battle', '1', source, MIN_STAKE_NANO), 'hash-1');
  assert.equal(await service.recoverDuplicate('battle', '1', source, MIN_STAKE_NANO), 'hash-1');
  assert.equal(gateway.sends, 1);
  const row = store.db.prepare('SELECT amount_minor,refund_signature FROM pay_recoveries WHERE source_signature=?').get(source) as any;
  assert.equal(row.amount_minor, MIN_STAKE_NANO); assert.equal(row.refund_signature, 'hash-1'); store.close();
});

test('reconciliation never crosses TON networks', async () => {
  const { store, service } = fixture(); const engine = new Engine(store);
  const testBattle = engine.createPaid('test', MIN_STAKE_NANO, '1', 1, 'testnet');
  const mainBattle = engine.createPaid('main', MIN_STAKE_NANO, '1', 2, 'mainnet');
  const insert = store.db.prepare("INSERT INTO pay_intents(battle_id,user_id,kind,amount_minor,state,updated_at) VALUES(?,?,'stake',?,'pending',?)");
  insert.run(testBattle.id, '1', MIN_STAKE_NANO, 1); insert.run(mainBattle.id, '1', MIN_STAKE_NANO, 2);
  const result = await service.reconcile(); assert.equal(result.checked, 1); store.close();
});

test('paid GRAM readiness never changes XP balances', () => {
  const store = new Store(':memory:'), engine = new Engine(store), battle = engine.createPaid('g', MIN_STAKE_NANO, '1', 1000);
  engine.join(battle.id, '1', 'A'); engine.join(battle.id, '2', 'B');
  const beforeA = store.account('1')!.balance, beforeB = store.account('2')!.balance;
  engine.readyPaid(battle.id, '1', 2000); engine.readyPaid(battle.id, '2', 3000);
  assert.equal(store.account('1')!.balance, beforeA); assert.equal(store.account('2')!.balance, beforeB);
  assert.equal(store.paidBattle(battle.id)?.asset, 'gram'); store.close();
});
