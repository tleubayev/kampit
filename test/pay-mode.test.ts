import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction } from '@solana/web3.js';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { CIRCLE_SOLANA_DEVNET_USDC_MINT, decryptWallet, encryptWallet, payConfigFromEnv, validatePayConfig } from '../src/pay-mode.ts';

test('wallet secrets are authenticated and decrypt only with the configured key', () => {
  const wallet = Keypair.generate(), key = 'a'.repeat(32), encrypted = encryptWallet(wallet.secretKey, key);
  assert.notEqual(encrypted, Buffer.from(wallet.secretKey).toString('base64'));
  assert.deepEqual(decryptWallet(encrypted, key), wallet.secretKey);
  assert.throws(() => decryptWallet(encrypted, 'b'.repeat(32)));
});

test('pay configuration is disabled by default and rejects non-devnet clusters', () => {
  assert.equal(payConfigFromEnv({} as NodeJS.ProcessEnv).enabled, false);
  assert.throws(() => payConfigFromEnv({ SOLANA_CLUSTER: 'mainnet-beta' } as NodeJS.ProcessEnv), /locked to Solana devnet/);
  assert.equal(CIRCLE_SOLANA_DEVNET_USDC_MINT, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  assert.equal('usdcMint' in payConfigFromEnv({ TEST_USDC_MINT: Keypair.generate().publicKey.toBase58() } as NodeJS.ProcessEnv), false);
});

test('enabled pay mode requires secrets and an explicit tester allowlist', () => {
  const treasury = Keypair.generate();
  const base = { enabled: true, cluster: 'devnet' as const, rpcUrl: 'https://api.devnet.solana.com', fallbackRpcUrl: 'https://api.devnet.solana.com', treasurySecret: Buffer.from(treasury.secretKey).toString('base64'), encryptionKey: 'x'.repeat(32), privyAppId: 'app-id', privyAppSecret: 'app-secret', privyTreasuryWalletId: '', allowedUsers: new Set(['1']) };
  assert.doesNotThrow(() => validatePayConfig(base));
  assert.throws(() => validatePayConfig({ ...base, allowedUsers: new Set() }), /PAY_MODE_TESTERS/);
});

test('Privy wallet migration removes the locally stored private key', async () => {
  const store = new Store(':memory:'); store.ensureAccount('1', 'Ali');
  const legacy = Keypair.generate(), encryptionKey = 'x'.repeat(32);
  store.db.prepare('INSERT INTO pay_wallets(user_id,address,encrypted_secret,created_at) VALUES(?,?,?,?)').run('1', legacy.publicKey.toBase58(), encryptWallet(legacy.secretKey, encryptionKey), 1);
  const imported: unknown[] = [];
  const privy = { create: async () => { throw new Error('unexpected create'); }, import: async (input: Record<string, unknown>) => { imported.push(input); return { id: 'privy-wallet-1', address: legacy.publicKey.toBase58() }; }, solana: () => ({ signTransaction: async () => ({ signed_transaction: '' }) }) };
  const service = new (await import('../src/pay-mode.ts')).DevnetUsdcService(store, { enabled: true, cluster: 'devnet', rpcUrl: 'http://localhost:8899', fallbackRpcUrl: 'http://localhost:8898', treasurySecret: Buffer.from(Keypair.generate().secretKey).toString('base64'), encryptionKey, privyAppId: 'app-id', privyAppSecret: 'app-secret', privyTreasuryWalletId: '', allowedUsers: new Set(['1']) }, privy);
  assert.equal((await service.wallet('1')).id, 'privy-wallet-1');
  const row = store.db.prepare('SELECT encrypted_secret,privy_wallet_id FROM pay_wallets WHERE user_id=?').get('1') as { encrypted_secret: string; privy_wallet_id: string };
  assert.equal(row.encrypted_secret, 'privy-managed'); assert.equal(row.privy_wallet_id, 'privy-wallet-1'); assert.equal(imported.length, 1); store.close();
});

test('a restart after broadcast recovers the signed payment without sending twice', async () => {
  const store = new Store(':memory:'); store.ensureAccount('1', 'Ali');
  const treasury = Keypair.generate(), user = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
  store.db.prepare("INSERT INTO pay_wallets(user_id,address,encrypted_secret,privy_wallet_id,created_at) VALUES(?,?,'privy-managed','user-wallet',1)").run('1', user.publicKey.toBase58());
  store.db.prepare("INSERT INTO app_meta(key,value) VALUES('privy_treasury_address',?)").run(treasury.publicKey.toBase58());
  const config = { enabled: true, cluster: 'devnet' as const, rpcUrl: 'http://primary.test', fallbackRpcUrl: 'http://fallback.test', treasurySecret: '', encryptionKey: '', privyAppId: 'app-id', privyAppSecret: 'app-secret', privyTreasuryWalletId: 'treasury-wallet', allowedUsers: new Set(['1']) };
  const privy = { create: async () => { throw new Error('unexpected create'); }, import: async () => { throw new Error('unexpected import'); }, solana: () => ({ signTransaction: async (_id: string, input: { transaction: Uint8Array }) => { const transaction = Transaction.from(input.transaction); transaction.partialSign(treasury); return { signed_transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }; } }) };
  let sends = 0, landed = false; const payloads = new Set<string>();
  const connection = { getAccountInfo: async () => ({}), getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }), sendRawTransaction: async (raw: Uint8Array) => { sends++; payloads.add(Buffer.from(raw).toString('base64')); throw new Error('connection lost after broadcast'); }, getSignatureStatuses: async () => ({ value: [landed ? { err: null, confirmationStatus: 'confirmed' } : null] }), getBlockHeight: async () => 50, confirmTransaction: async () => ({ value: { err: null } }) };
  const first = new (await import('../src/pay-mode.ts')).DevnetUsdcService(store, config, privy); (first as any).connection = connection; (first as any).fallbackConnection = connection;
  await assert.rejects(() => first.pay('1', 'battle', 'payout', 100_000), /pending/);
  const persisted = store.db.prepare("SELECT state,signature,raw_transaction FROM pay_intents WHERE battle_id='battle' AND user_id='1' AND kind='payout'").get() as any;
  assert.equal(persisted.state, 'signed'); assert.ok(persisted.signature); assert.ok(persisted.raw_transaction); assert.equal(payloads.size, 1); const sendsBeforeRestart = sends;
  landed = true;
  const restarted = new (await import('../src/pay-mode.ts')).DevnetUsdcService(store, config, privy); (restarted as any).connection = connection; (restarted as any).fallbackConnection = connection;
  assert.equal(await restarted.pay('1', 'battle', 'payout', 100_000), persisted.signature);
  assert.equal(sends, sendsBeforeRestart); assert.equal(payloads.size, 1); assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM pay_transfers WHERE battle_id='battle'").get() as any).count, 1); store.close();
});

test('payment tables enforce one transfer kind per user and battle', () => {
  const store = new Store(':memory:'); store.ensureAccount('1', 'Ali');
  store.db.prepare('INSERT INTO pay_wallets(user_id,address,encrypted_secret,created_at) VALUES(?,?,?,?)').run('1', Keypair.generate().publicKey.toBase58(), 'encrypted', 1);
  const insert = store.db.prepare("INSERT INTO pay_transfers(battle_id,user_id,kind,amount_minor,signature,created_at) VALUES('b','1','stake',100000,'sig',1)");
  insert.run(); assert.throws(() => insert.run()); store.close();
});

test('paid rounds use test-USDC readiness without changing XP balances', () => {
  const store = new Store(':memory:'), engine = new Engine(store);
  const battle = engine.createPaid('g', 100_000, '1', 1000);
  engine.join(battle.id, '1', 'Ali'); engine.join(battle.id, '2', 'Dana');
  engine.readyPaid(battle.id, '1', 1000); engine.readyPaid(battle.id, '2', 1000);
  assert.equal(store.account('1')!.balance, 1000);
  engine.startNow(battle.id, '1', 1000);
  engine.tick(4000, { price: 100, at: 4000, sourceTime: '' });
  engine.predict(battle.id, '1', 'LONG', 5000); engine.predict(battle.id, '2', 'SHORT', 5000);
  engine.tick(64000, { price: 101, at: 64000, sourceTime: '' });
  assert.equal(store.account('1')!.balance, 1000);
  assert.equal(store.paidBattle(battle.id)!.settlement_status, 'pending');
  store.close();
});
