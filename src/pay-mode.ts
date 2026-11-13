import { randomBytes } from 'node:crypto';
import { Address, beginCell, internal, SendMode } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import type { Store } from './store.ts';
import { GameError } from './engine.ts';

export const NANO_GRAM = 1_000_000_000;
export const MIN_STAKE_NANO = 100_000_000;
export const MAX_STAKE_NANO = 20_000_000_000;
export const MAX_PAYMENT_CONCURRENCY = 4;
const INTENT_TTL_MS = 5 * 60_000;

export type PayConfig = {
  enabled: boolean; publicAccess: boolean; network: 'testnet'; rpcUrl: string; apiKey: string;
  escrowMnemonic: string; treasuryAddress: string; allowedUsers: Set<string>;
};
export type ChainTransfer = { hash: string; from: string; to: string; amountNano: number; comment: string };
export type TonGateway = {
  address(mnemonic: string): Promise<string>;
  balance(address: string): Promise<number>;
  incoming(address: string): Promise<ChainTransfer[]>;
  send(mnemonic: string, to: string, amountNano: number, comment: string): Promise<string>;
};
type PaymentKind = 'stake' | 'payout' | 'refund' | 'house';
type PaymentIntent = { battle_id: string; user_id: string; kind: PaymentKind; amount_minor: number; state: 'pending' | 'signed' | 'confirmed' | 'failed'; signature: string | null; raw_transaction: string | null; blockhash: string | null; last_valid_block_height: number | null; attempt: number };

function words(value: string) { return value.trim().split(/\s+/).filter(Boolean); }
function commentBody(value: string) { return beginCell().storeUint(0, 32).storeStringTail(value).endCell(); }
function parseComment(body: { beginParse(): any }) { try { const slice = body.beginParse(); return slice.remainingBits >= 32 && slice.loadUint(32) === 0 ? slice.loadStringTail() : ''; } catch { return ''; } }
function canonical(value: string) { return Address.parse(value).toRawString(); }

export function payConfigFromEnv(env = process.env): PayConfig {
  const network = env.TON_NETWORK || 'testnet';
  if (network !== 'testnet') throw new Error('Pay mode is locked to TON testnet in this build');
  return {
    enabled: env.PAY_MODE_ENABLED === 'true', publicAccess: env.PAY_MODE_PUBLIC === 'true', network: 'testnet',
    rpcUrl: env.TON_RPC_URL || 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey: env.TON_API_KEY || '',
    escrowMnemonic: env.TON_ESCROW_MNEMONIC || '', treasuryAddress: env.TON_TREASURY_ADDRESS || '',
    allowedUsers: new Set((env.PAY_MODE_TESTERS || '').split(',').map(value => value.trim()).filter(Boolean)),
  };
}
export function validatePayConfig(config: PayConfig) {
  if (!config.enabled) return;
  if (!config.publicAccess && !config.allowedUsers.size) throw new Error('Pay mode requires PAY_MODE_PUBLIC=true or PAY_MODE_TESTERS');
  if (!config.apiKey) throw new Error('TON_API_KEY is required when GRAM test mode is enabled');
  if (![12, 24].includes(words(config.escrowMnemonic).length)) throw new Error('TON_ESCROW_MNEMONIC must contain a 12- or 24-word mnemonic');
  try { Address.parse(config.treasuryAddress); } catch { throw new Error('TON_TREASURY_ADDRESS must be a valid TON address'); }
}

export class TonCenterGateway implements TonGateway {
  private client: TonClient;
  private wallets = new Map<string, Promise<{ contract: WalletContractV5R1; secretKey: Buffer }>>();
  constructor(config: PayConfig) { this.client = new TonClient({ endpoint: config.rpcUrl, apiKey: config.apiKey || undefined }); }
  private wallet(mnemonic: string) {
    let value = this.wallets.get(mnemonic);
    if (!value) {
      value = mnemonicToPrivateKey(words(mnemonic)).then(key => ({
        contract: WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey, walletId: { networkGlobalId: -3 } }), secretKey: key.secretKey,
      }));
      this.wallets.set(mnemonic, value);
    }
    return value;
  }
  async address(mnemonic: string) { return (await this.wallet(mnemonic)).contract.address.toString({ testOnly: true, bounceable: false }); }
  async balance(address: string) { return Number(await this.client.getBalance(Address.parse(address))); }
  private async transactions(address: Address) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.client.getTransactions(address, { limit: 100 }); }
      catch (error) { lastError = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1))); }
    }
    throw lastError;
  }
  async incoming(address: string) {
    const target = Address.parse(address), transactions = await this.transactions(target), result: ChainTransfer[] = [];
    for (const tx of transactions) {
      const message = tx.inMessage; if (!message || message.info.type !== 'internal') continue;
      result.push({ hash: tx.hash().toString('hex'), from: message.info.src.toRawString(), to: target.toRawString(), amountNano: Number(message.info.value.coins), comment: parseComment(message.body) });
    }
    return result;
  }
  private async outgoing(address: string) {
    const owner = Address.parse(address), transactions = await this.transactions(owner), result: ChainTransfer[] = [];
    for (const tx of transactions) for (const message of tx.outMessages.values()) {
      if (message.info.type !== 'internal') continue;
      result.push({ hash: tx.hash().toString('hex'), from: owner.toRawString(), to: message.info.dest.toRawString(), amountNano: Number(message.info.value.coins), comment: parseComment(message.body) });
    }
    return result;
  }
  async send(mnemonic: string, to: string, amountNano: number, comment: string) {
    const owner = await this.wallet(mnemonic), opened = this.client.open(owner.contract);
    const find = async () => (await this.outgoing(owner.contract.address.toString({ testOnly: true }))).find(item => canonical(item.to) === canonical(to) && item.amountNano === amountNano && item.comment === comment);
    const existing = await find(); if (existing) return existing.hash;
    const seqno = await opened.getSeqno();
    await opened.sendTransfer({ seqno, secretKey: owner.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY, messages: [internal({ to: Address.parse(to), value: BigInt(amountNano), bounce: false, body: commentBody(comment) })] });
    for (let attempt = 0; attempt < 20; attempt++) { await new Promise(resolve => setTimeout(resolve, 1000)); const found = await find(); if (found) return found.hash; }
    throw new Error('GRAM transfer was submitted but is still awaiting final confirmation');
  }
}

export class TonGramService {
  store: Store; config: PayConfig; gateway: TonGateway;
  private roles?: { escrow: string; treasury: string };
  private payments = new Map<string, Promise<string>>(); private paymentSlots = 0; private paymentWaiters: (() => void)[] = [];
  constructor(store: Store, config: PayConfig, gateway?: TonGateway) { this.store = store; this.config = config; validatePayConfig(config); this.gateway = gateway || new TonCenterGateway(config); }
  async initialize() {
    const escrow = await this.gateway.address(this.config.escrowMnemonic), treasury = this.config.treasuryAddress;
    if (canonical(escrow) === canonical(treasury)) throw new Error('Escrow and treasury must be different TON wallets');
    this.roles = { escrow, treasury }; return this.roles;
  }
  private async roleAddresses() { return this.roles || this.initialize(); }
  private async withPaymentSlot<T>(operation: () => Promise<T>) { if (this.paymentSlots >= MAX_PAYMENT_CONCURRENCY) await new Promise<void>(resolve => this.paymentWaiters.push(resolve)); this.paymentSlots++; try { return await operation(); } finally { this.paymentSlots--; this.paymentWaiters.shift()?.(); } }
  assertTester(userId: string) { if (!this.config.enabled || (!this.config.publicAccess && !this.config.allowedUsers.has(userId))) throw new GameError('GRAM test mode is not enabled for this account', 403); }
  private intent(battleId: string, userId: string, kind: PaymentKind) { return this.store.db.prepare('SELECT * FROM pay_intents WHERE battle_id=? AND user_id=? AND kind=?').get(battleId, userId, kind) as PaymentIntent | undefined; }
  async info(userId: string) {
    this.assertTester(userId); const roles = await this.roleAddresses();
    const linked = this.store.db.prepare("SELECT address FROM pay_wallets WHERE user_id=? AND encrypted_secret='ton-connect'").get(userId) as { address: string } | undefined;
    return { enabled: true, network: this.config.network, currency: 'Testnet GRAM', walletAddress: linked?.address || null, escrowAddress: roles.escrow };
  }
  async prepareStake(battleId: string, userId: string, amountNano: number, walletAddress: string) {
    this.assertTester(userId);
    if (!Number.isSafeInteger(amountNano) || amountNano < MIN_STAKE_NANO || amountNano > MAX_STAKE_NANO) throw new GameError('Stake must be between 0.10 and 20 GRAM');
    let wallet: string; try { wallet = Address.parse(walletAddress).toString({ testOnly: true, bounceable: false }); } catch { throw new GameError('Connect a valid TON Testnet wallet'); }
    const existing = this.intent(battleId, userId, 'stake'); if (existing?.state === 'confirmed') return { confirmed: true };
    const activeIntent = existing?.last_valid_block_height && existing.last_valid_block_height > Date.now();
    if (existing && activeIntent && existing.raw_transaction && canonical(existing.raw_transaction) !== canonical(wallet)) throw new GameError('Finish this stake with the wallet that created it, or wait for it to expire', 409);
    const paymentId = activeIntent && existing?.blockhash ? existing.blockhash : randomBytes(24).toString('base64url');
    const expiresAt = activeIntent ? existing!.last_valid_block_height! : Date.now() + INTENT_TTL_MS;
    if (!existing) this.store.db.prepare("INSERT INTO pay_intents(battle_id,user_id,kind,amount_minor,state,raw_transaction,blockhash,last_valid_block_height,updated_at) VALUES(?,?,'stake',?,'pending',?,?,?,?)").run(battleId, userId, amountNano, wallet, paymentId, expiresAt, Date.now());
    else this.store.db.prepare("UPDATE pay_intents SET raw_transaction=?,blockhash=?,last_valid_block_height=?,updated_at=? WHERE battle_id=? AND user_id=? AND kind='stake' AND state!='confirmed'").run(wallet, paymentId, expiresAt, Date.now(), battleId, userId);
    this.store.db.prepare("INSERT INTO pay_wallets(user_id,address,encrypted_secret,created_at) VALUES(?,?,'ton-connect',?) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,encrypted_secret='ton-connect',privy_wallet_id=NULL").run(userId, wallet, Date.now());
    const roles = await this.roleAddresses();
    return { confirmed: false, paymentId, address: roles.escrow, amountNano: String(amountNano), payload: commentBody(`kampit:${paymentId}`).toBoc().toString('base64'), validUntil: Math.floor(expiresAt / 1000), network: '-3' };
  }
  async confirmStake(battleId: string, userId: string, amountNano: number) {
    const intent = this.intent(battleId, userId, 'stake');
    if (!intent || intent.amount_minor !== amountNano || !intent.blockhash || !intent.raw_transaction) throw new GameError('Create and approve the GRAM stake first', 409);
    if (intent.state === 'confirmed' && intent.signature) return intent.signature;
    if (intent.last_valid_block_height && intent.last_valid_block_height < Date.now()) throw new GameError('Stake request expired. Please approve a new transaction.', 409);
    const roles = await this.roleAddresses();
    const transfer = (await this.gateway.incoming(roles.escrow)).find(item => item.comment === `kampit:${intent.blockhash}` && item.amountNano === amountNano && canonical(item.from) === canonical(intent.raw_transaction!) && canonical(item.to) === canonical(roles.escrow));
    if (!transfer) throw new GameError('GRAM stake is still confirming', 409);
    this.recordConfirmed(intent, transfer.hash); return transfer.hash;
  }
  private recordConfirmed(intent: PaymentIntent, hash: string) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { this.store.db.prepare("UPDATE pay_intents SET state='confirmed',signature=?,updated_at=? WHERE battle_id=? AND user_id=? AND kind=? AND state!='confirmed'").run(hash, Date.now(), intent.battle_id, intent.user_id, intent.kind); this.store.db.prepare('INSERT OR IGNORE INTO pay_transfers(battle_id,user_id,kind,amount_minor,signature,created_at) VALUES(?,?,?,?,?,?)').run(intent.battle_id, intent.user_id, intent.kind, intent.amount_minor, hash, Date.now()); this.store.db.exec('COMMIT'); }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private payment(battleId: string, userId: string, kind: Exclude<PaymentKind, 'stake'>, amountNano: number, destination: () => Promise<string>) {
    if (!Number.isSafeInteger(amountNano) || amountNano <= 0) throw new GameError('Invalid GRAM amount');
    const key = `${battleId}:${userId}:${kind}`, active = this.payments.get(key); if (active) return active;
    const task = this.withPaymentSlot(async () => {
      const prior = this.store.db.prepare('SELECT amount_minor,signature FROM pay_transfers WHERE battle_id=? AND user_id=? AND kind=?').get(battleId, userId, kind) as { amount_minor: number; signature: string } | undefined;
      if (prior) { if (prior.amount_minor !== amountNano) throw new Error('Recorded GRAM payment amount mismatch'); return prior.signature; }
      const paymentId = `${kind}:${battleId}:${userId}`;
      this.store.db.prepare("INSERT OR IGNORE INTO pay_intents(battle_id,user_id,kind,amount_minor,state,blockhash,updated_at) VALUES(?,?,?,?,'pending',?,?)").run(battleId, userId, kind, amountNano, paymentId, Date.now());
      const intent = this.intent(battleId, userId, kind)!; if (intent.amount_minor !== amountNano) throw new Error('Payment intent amount mismatch');
      const hash = await this.gateway.send(this.config.escrowMnemonic, await destination(), amountNano, `kampit-out:${paymentId}`); this.recordConfirmed(intent, hash); return hash;
    });
    this.payments.set(key, task); void task.finally(() => this.payments.delete(key)).catch(() => {}); return task;
  }
  async pay(userId: string, battleId: string, kind: 'payout' | 'refund', amountNano: number) { return this.payment(battleId, userId, kind, amountNano, async () => { const wallet = this.store.db.prepare("SELECT address FROM pay_wallets WHERE user_id=? AND encrypted_secret='ton-connect'").get(userId) as { address: string } | undefined; if (!wallet) throw new Error('Confirmed player TON wallet is missing'); return wallet.address; }); }
  async house(battleId: string, amountNano: number) { return this.payment(battleId, 'house', 'house', amountNano, async () => (await this.roleAddresses()).treasury); }
  history(userId: string, limit = 50) { this.assertTester(userId); return (this.store.db.prepare("SELECT battle_id AS id,kind,amount_minor,state,signature,attempt,updated_at FROM pay_intents WHERE user_id=? AND kind!='withdrawal' ORDER BY updated_at DESC LIMIT ?").all(userId, Math.min(100, Math.max(1, limit))) as any[]).map(row => ({ id: row.id, kind: row.kind, amountNano: Number(row.amount_minor), state: row.state, hash: row.signature, updatedAt: Number(row.updated_at), explorerUrl: row.signature ? `https://testnet.tonviewer.com/transaction/${row.signature}` : null })); }
  async reconcile() {
    const pendingStakes = this.store.db.prepare("SELECT * FROM pay_intents WHERE kind='stake' AND state='pending' ORDER BY updated_at LIMIT 100").all() as PaymentIntent[];
    let recovered = 0, failed = 0;
    for (const row of pendingStakes) { try { await this.confirmStake(row.battle_id, row.user_id, row.amount_minor); recovered++; } catch (error) { if (!(error instanceof GameError && error.status === 409)) { failed++; console.error('GRAM reconciliation failed:', row.battle_id, error instanceof Error ? error.message : 'upstream error'); } } }
    const roles = await this.roleAddresses(), [escrowNano, treasuryNano] = await Promise.all([this.gateway.balance(roles.escrow), this.gateway.balance(roles.treasury)]);
    const obligationsNano = Number((this.store.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS total FROM pay_intents WHERE kind IN ('payout','refund') AND state IN ('pending','signed')").get() as { total: number }).total);
    return { checked: pendingStakes.length, recovered, failed, pending: pendingStakes.length - recovered, wallets: { escrow: { address: roles.escrow, balanceNano: escrowNano, obligationsNano }, treasury: { address: roles.treasury, balanceNano: treasuryNano } }, alerts: [...(escrowNano < obligationsNano ? ['Escrow GRAM is below pending payout obligations'] : []), ...(failed ? [`${failed} GRAM reconciliation attempt(s) need attention`] : [])] };
  }
}
