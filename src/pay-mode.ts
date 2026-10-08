import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrivyClient } from '@privy-io/node';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import type { Store } from './store.ts';
import { GameError } from './engine.ts';

export const CIRCLE_SOLANA_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const WITHDRAWAL_MIN_MINOR = 100_000;
export const WITHDRAWAL_MAX_MINOR = 20_000_000;
export const WITHDRAWAL_DAILY_LIMIT_MINOR = 100_000_000;
export const WITHDRAWAL_APPROVAL_THRESHOLD_MINOR = 5_000_000;
export const DEVNET_FAUCET_AMOUNT_MINOR = 1_000_000;
export type PayConfig = { enabled: boolean; publicAccess: boolean; cluster: 'devnet'; rpcUrl: string; fallbackRpcUrl: string; treasurySecret: string; encryptionKey: string; privyAppId: string; privyAppSecret: string; privyTreasuryWalletId: string; allowedUsers: Set<string> };
type ManagedWallet = { id: string; address: string };
type PaymentKind = 'stake' | 'payout' | 'refund' | 'withdrawal' | 'house';
type PaymentIntent = { battle_id: string; user_id: string; kind: PaymentKind; amount_minor: number; state: 'pending' | 'signed' | 'confirmed' | 'failed'; signature: string | null; raw_transaction: string | null; blockhash: string | null; last_valid_block_height: number | null; attempt: number };
type PrivyWalletClient = { create(input: Record<string, unknown>): Promise<ManagedWallet>; import(input: Record<string, unknown>): Promise<ManagedWallet>; solana(): { signTransaction(walletId: string, input: { transaction: Uint8Array; idempotency_key?: string }): Promise<{ signed_transaction: string }> } };

export function payConfigFromEnv(env = process.env): PayConfig {
  const cluster = env.SOLANA_CLUSTER || 'devnet';
  if (cluster !== 'devnet') throw new Error('Pay mode is locked to Solana devnet in this build');
  return { enabled: env.PAY_MODE_ENABLED === 'true', publicAccess: env.PAY_MODE_PUBLIC === 'true', cluster: 'devnet', rpcUrl: env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', fallbackRpcUrl: env.SOLANA_FALLBACK_RPC_URL || 'https://api.devnet.solana.com', treasurySecret: env.SOLANA_TREASURY_SECRET || '', encryptionKey: env.WALLET_ENCRYPTION_KEY || '', privyAppId: env.PRIVY_APP_ID || '', privyAppSecret: env.PRIVY_APP_SECRET || '', privyTreasuryWalletId: env.PRIVY_TREASURY_WALLET_ID || '', allowedUsers: new Set((env.PAY_MODE_TESTERS || '').split(',').map(value => value.trim()).filter(Boolean)) };
}
export function validatePayConfig(config: PayConfig) {
  if (!config.enabled) return;
  if (!config.privyAppId || !config.privyAppSecret || (!config.publicAccess && !config.allowedUsers.size)) throw new Error('Pay mode requires PRIVY_APP_ID, PRIVY_APP_SECRET, and either PAY_MODE_PUBLIC=true or PAY_MODE_TESTERS');
  if (!config.privyTreasuryWalletId && !config.treasurySecret) throw new Error('Set PRIVY_TREASURY_WALLET_ID or temporarily keep SOLANA_TREASURY_SECRET for one-time migration');
  if (config.treasurySecret && config.encryptionKey.length < 32) throw new Error('WALLET_ENCRYPTION_KEY (32+ chars) is required while legacy wallets are being migrated');
  if (config.treasurySecret) decodeKeypair(config.treasurySecret);
}
function cryptoKey(secret: string) { return createHash('sha256').update(secret).digest(); }
export function encryptWallet(secret: Uint8Array, password: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cryptoKey(password), iv); const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]); return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.'); }
export function decryptWallet(value: string, password: string) { const parts = value.split('.'); if (parts.length !== 3) throw new Error('Invalid encrypted wallet'); const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url')); const cipher = createDecipheriv('aes-256-gcm', cryptoKey(password), iv); cipher.setAuthTag(tag); return new Uint8Array(Buffer.concat([cipher.update(encrypted), cipher.final()])); }
export function decodeKeypair(value: string) { const bytes = value.trim().startsWith('[') ? Uint8Array.from(JSON.parse(value)) : new Uint8Array(Buffer.from(value, 'base64')); return Keypair.fromSecretKey(bytes); }
function base58(bytes: Uint8Array) { const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let value = 0n; for (const byte of bytes) value = value * 256n + BigInt(byte); let encoded = ''; while (value) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n; } for (const byte of bytes) { if (byte) break; encoded = '1' + encoded; } return encoded || '1'; }

export class DevnetUsdcService {
  connection: Connection; fallbackConnection: Connection; mint: PublicKey; store: Store; config: PayConfig; privy: PrivyWalletClient;
  constructor(store: Store, config: PayConfig, privy?: PrivyWalletClient) { this.store = store; this.config = config; validatePayConfig(config); this.connection = new Connection(config.rpcUrl, 'confirmed'); this.fallbackConnection = new Connection(config.fallbackRpcUrl, 'confirmed'); this.mint = new PublicKey(CIRCLE_SOLANA_DEVNET_USDC_MINT); this.privy = privy || (new PrivyClient({ appId: config.privyAppId, appSecret: config.privyAppSecret }).wallets() as unknown as PrivyWalletClient); }
  private async rpc<T>(operation: (connection: Connection) => Promise<T>) { try { return await operation(this.connection); } catch (primaryError) { if (this.config.fallbackRpcUrl === this.config.rpcUrl) throw primaryError; return operation(this.fallbackConnection); } }
  private payments = new Map<string, Promise<string>>();
  private withdrawals = new Map<string, Promise<{ status: string; signature?: string }>>();
  assertTester(userId: string) { if (!this.config.enabled || (!this.config.publicAccess && !this.config.allowedUsers.has(userId))) throw new GameError('Test pay mode is not enabled for this account', 403); }
  async wallet(userId: string): Promise<ManagedWallet> {
    this.assertTester(userId);
    const found = this.store.db.prepare('SELECT address,encrypted_secret,privy_wallet_id FROM pay_wallets WHERE user_id=?').get(userId) as { address: string; encrypted_secret: string; privy_wallet_id: string | null } | undefined;
    if (found?.privy_wallet_id) return { id: found.privy_wallet_id, address: found.address };
    let wallet: ManagedWallet;
    if (found) {
      if (!this.config.encryptionKey) throw new Error('WALLET_ENCRYPTION_KEY is required to migrate this legacy wallet');
      wallet = await this.privy.import({ wallet: { private_key: decryptWallet(found.encrypted_secret, this.config.encryptionKey), address: found.address, chain_type: 'solana', entropy_type: 'private-key' }, external_id: `kampit_user_${userId}`, display_name: `Kampit user ${userId}` });
      this.store.db.prepare("UPDATE pay_wallets SET privy_wallet_id=?,encrypted_secret='privy-managed' WHERE user_id=?").run(wallet.id, userId);
    } else {
      wallet = await this.privy.create({ chain_type: 'solana', external_id: `kampit_user_${userId}`, display_name: `Kampit user ${userId}`, idempotency_key: `kampit-user-${userId}` });
      this.store.db.prepare("INSERT INTO pay_wallets(user_id,address,encrypted_secret,privy_wallet_id,created_at) VALUES(?,?,'privy-managed',?,?)").run(userId, wallet.address, wallet.id, Date.now());
    }
    return wallet;
  }
  private async treasuryWallet(): Promise<ManagedWallet> {
    const saved = this.config.privyTreasuryWalletId || (this.store.db.prepare("SELECT value FROM app_meta WHERE key='privy_treasury_wallet_id'").get() as { value: string } | undefined)?.value;
    const storedAddress = (this.store.db.prepare("SELECT value FROM app_meta WHERE key='privy_treasury_address'").get() as { value: string } | undefined)?.value;
    if (saved) { const address = storedAddress || (this.config.treasurySecret ? decodeKeypair(this.config.treasurySecret).publicKey.toBase58() : ''); if (!address) throw new Error('Migrated treasury address is missing'); return { id: saved, address }; }
    const keypair = decodeKeypair(this.config.treasurySecret);
    const wallet = await this.privy.import({ wallet: { private_key: keypair.secretKey, address: keypair.publicKey.toBase58(), chain_type: 'solana', entropy_type: 'private-key' }, external_id: 'kampit_devnet_treasury', display_name: 'Kampit devnet treasury' });
    this.store.db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('privy_treasury_wallet_id',?)").run(wallet.id); this.store.db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('privy_treasury_address',?)").run(wallet.address); return wallet;
  }
  private async roleWallet(role: 'fee_payer' | 'operating'): Promise<ManagedWallet> { const idKey = `privy_${role}_wallet_id`, addressKey = `privy_${role}_address`; const saved = this.store.db.prepare('SELECT value FROM app_meta WHERE key=?').get(idKey) as { value: string } | undefined; const address = this.store.db.prepare('SELECT value FROM app_meta WHERE key=?').get(addressKey) as { value: string } | undefined; if (saved && address) return { id: saved.value, address: address.value }; const wallet = await this.privy.create({ chain_type: 'solana', external_id: `kampit_devnet_${role}`, display_name: `Kampit devnet ${role.replace('_',' ')}`, idempotency_key: `kampit-devnet-${role}` }); this.store.db.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)').run(idKey, wallet.id); this.store.db.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)').run(addressKey, wallet.address); return wallet; }
  private feePayerWallet() { return this.roleWallet('fee_payer'); }
  private operatingWallet() { return this.roleWallet('operating'); }
  async depositAddress(userId: string) { return getAssociatedTokenAddressSync(this.mint, new PublicKey((await this.wallet(userId)).address)).toBase58(); }
  async balanceMinor(userId: string) { const address = new PublicKey(await this.depositAddress(userId)); return this.rpc(async connection => { if (!await connection.getAccountInfo(address, 'confirmed')) return 0; return Number((await getAccount(connection, address, 'confirmed')).amount); }); }
  private async sign(transaction: Transaction, walletIds: string[]) { const expectedMessage = transaction.serializeMessage(); let bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }); for (const walletId of walletIds) { const signed = await this.privy.solana().signTransaction(walletId, { transaction: bytes, idempotency_key: `kampit-${walletId}-${randomBytes(12).toString('hex')}` }); bytes = Buffer.from(signed.signed_transaction, 'base64'); const returned = Transaction.from(bytes); if (!Buffer.from(returned.serializeMessage()).equals(Buffer.from(expectedMessage)) || !returned.verifySignatures(false)) throw new Error('Privy returned an invalid or modified transaction'); } return bytes; }
  private intent(battleId: string, userId: string, kind: PaymentKind) { return this.store.db.prepare('SELECT * FROM pay_intents WHERE battle_id=? AND user_id=? AND kind=?').get(battleId, userId, kind) as PaymentIntent | undefined; }
  private async confirmed(signature: string, requireEveryProvider = false) { const providers = this.config.fallbackRpcUrl === this.config.rpcUrl ? [this.connection] : [this.connection, this.fallbackConnection]; let checked = 0, lastError: unknown; for (const connection of providers) { let status; try { status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]; checked++; } catch (error) { lastError = error; continue; } if (status?.err) throw new Error(`Solana transaction ${signature} failed on chain`); if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return true; } if (!checked || (requireEveryProvider && checked !== providers.length)) throw lastError || new Error('Could not verify payment signature with every RPC provider'); return false; }
  private recordConfirmed(intent: PaymentIntent, signature: string) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare("UPDATE pay_intents SET state='confirmed',signature=?,updated_at=? WHERE battle_id=? AND user_id=? AND kind=?").run(signature, Date.now(), intent.battle_id, intent.user_id, intent.kind);
      this.store.db.prepare('INSERT OR IGNORE INTO pay_transfers(battle_id,user_id,kind,amount_minor,signature,created_at) VALUES(?,?,?,?,?,?)').run(intent.battle_id, intent.user_id, intent.kind, intent.amount_minor, signature, Date.now());
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private async executePayment(intent: PaymentIntent, owner: ManagedWallet, destinationOwner: PublicKey) {
    if (intent.state === 'confirmed' && intent.signature) return intent.signature;
    if (intent.signature && intent.raw_transaction && intent.blockhash && intent.last_valid_block_height) {
      if (await this.confirmed(intent.signature)) { this.recordConfirmed(intent, intent.signature); return intent.signature; }
      const height = await this.rpc(connection => connection.getBlockHeight('confirmed'));
      if (height <= intent.last_valid_block_height) {
        try { await this.rpc(connection => connection.sendRawTransaction(Buffer.from(intent.raw_transaction!, 'base64'), { skipPreflight: false, maxRetries: 3 })); } catch { if (!await this.confirmed(intent.signature)) throw new Error('Payment broadcast is pending; retrying safely'); }
        await this.rpc(connection => connection.confirmTransaction({ signature: intent.signature!, blockhash: intent.blockhash!, lastValidBlockHeight: intent.last_valid_block_height! }, 'confirmed'));
        this.recordConfirmed(intent, intent.signature); return intent.signature;
      }
      if (await this.confirmed(intent.signature, true)) { this.recordConfirmed(intent, intent.signature); return intent.signature; }
      this.store.db.prepare("UPDATE pay_intents SET state='pending',signature=NULL,raw_transaction=NULL,blockhash=NULL,last_valid_block_height=NULL,updated_at=? WHERE battle_id=? AND user_id=? AND kind=?").run(Date.now(), intent.battle_id, intent.user_id, intent.kind);
    }
    const feePayer = await this.feePayerWallet(), feePayerAddress = new PublicKey(feePayer.address), ownerAddress = new PublicKey(owner.address); const source = getAssociatedTokenAddressSync(this.mint, ownerAddress), destination = getAssociatedTokenAddressSync(this.mint, destinationOwner), transaction = new Transaction();
    if (!await this.rpc(connection => connection.getAccountInfo(destination))) transaction.add(createAssociatedTokenAccountInstruction(feePayerAddress, destination, destinationOwner, this.mint)); transaction.add(createTransferCheckedInstruction(source, this.mint, destination, ownerAddress, intent.amount_minor, 6)); transaction.feePayer = feePayerAddress;
    const latest = await this.rpc(connection => connection.getLatestBlockhash('confirmed')); transaction.recentBlockhash = latest.blockhash;
    const signed = await this.sign(transaction, owner.id === feePayer.id ? [feePayer.id] : [feePayer.id, owner.id]); const decoded = Transaction.from(signed); const signatureBytes = decoded.signatures[0]?.signature; if (!signatureBytes) throw new Error('Signed Solana transaction has no fee-payer signature'); const signature = base58(signatureBytes);
    this.store.db.prepare("UPDATE pay_intents SET state='signed',signature=?,raw_transaction=?,blockhash=?,last_valid_block_height=?,attempt=attempt+1,updated_at=? WHERE battle_id=? AND user_id=? AND kind=?").run(signature, Buffer.from(signed).toString('base64'), latest.blockhash, latest.lastValidBlockHeight, Date.now(), intent.battle_id, intent.user_id, intent.kind);
    const signedIntent = this.intent(intent.battle_id, intent.user_id, intent.kind)!;
    try { await this.rpc(connection => connection.sendRawTransaction(signed, { skipPreflight: false, maxRetries: 3 })); } catch { if (!await this.confirmed(signature)) throw new Error('Payment broadcast is pending; retrying safely'); }
    await this.rpc(connection => connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed'));
    this.recordConfirmed(signedIntent, signature); return signature;
  }
  private payment(battleId: string, userId: string, kind: PaymentKind, amountMinor: number, resolveParties: () => Promise<[ManagedWallet, PublicKey]>) { if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new GameError('Invalid USDC amount'); const key = `${battleId}:${userId}:${kind}`; const active = this.payments.get(key); if (active) return active; const task = (async () => { const prior = this.store.db.prepare('SELECT amount_minor,signature FROM pay_transfers WHERE battle_id=? AND user_id=? AND kind=?').get(battleId, userId, kind) as { amount_minor: number; signature: string } | undefined; if (prior) { if (prior.amount_minor !== amountMinor) throw new Error('Recorded payment amount mismatch'); this.store.db.prepare("INSERT OR IGNORE INTO pay_intents(battle_id,user_id,kind,amount_minor,state,signature,updated_at) VALUES(?,?,?,?,'confirmed',?,?)").run(battleId, userId, kind, amountMinor, prior.signature, Date.now()); return prior.signature; } this.store.db.prepare('INSERT OR IGNORE INTO pay_intents(battle_id,user_id,kind,amount_minor,updated_at) VALUES(?,?,?,?,?)').run(battleId, userId, kind, amountMinor, Date.now()); const intent = this.intent(battleId, userId, kind)!; if (intent.amount_minor !== amountMinor) throw new Error('Payment intent amount mismatch'); try { const [owner, destination] = await resolveParties(); return await this.executePayment(intent, owner, destination); } catch (error) { if (error instanceof Error && error.message.includes('failed on chain')) this.store.db.prepare("UPDATE pay_intents SET state='failed',updated_at=? WHERE battle_id=? AND user_id=? AND kind=?").run(Date.now(), battleId, userId, kind); throw error; } })(); this.payments.set(key, task); void task.finally(() => this.payments.delete(key)).catch(() => {}); return task; }
  async lockStake(battleId: string, userId: string, amountMinor: number) {
    this.assertTester(userId);
    if (await this.balanceMinor(userId) < amountMinor) {
      this.store.db.prepare("UPDATE pay_intents SET state='failed',signature=NULL,raw_transaction=NULL,blockhash=NULL,last_valid_block_height=NULL,updated_at=? WHERE battle_id=? AND user_id=? AND kind='stake' AND state!='confirmed'").run(Date.now(), battleId, userId);
      throw new GameError('Insufficient test USDC. Claim 1 test USDC in the wallet section first.');
    }
    return this.payment(battleId, userId, 'stake', amountMinor, async () => { const treasury = await this.treasuryWallet(); return [await this.wallet(userId), new PublicKey(treasury.address)]; });
  }
  async pay(userId: string, battleId: string, kind: 'payout' | 'refund', amountMinor: number) { return this.payment(battleId, userId, kind, amountMinor, async () => { const [treasury, wallet] = await Promise.all([this.treasuryWallet(), this.wallet(userId)]); return [treasury, new PublicKey(wallet.address)]; }); }
  async house(battleId: string, amountMinor: number) { return this.payment(battleId, 'house', 'house', amountMinor, async () => { const [escrow, operating] = await Promise.all([this.treasuryWallet(), this.operatingWallet()]); return [escrow, new PublicKey(operating.address)]; }); }
  faucetStatus(userId: string) {
    this.assertTester(userId);
    const claim = this.store.db.prepare('SELECT amount_minor,signature,created_at FROM pay_faucets WHERE user_id=? AND amount_minor=?').get(userId, DEVNET_FAUCET_AMOUNT_MINOR) as { amount_minor: number; signature: string; created_at: number } | undefined;
    const intent = this.intent(`faucet:${userId}`, userId, 'payout');
    return { amountMinor: DEVNET_FAUCET_AMOUNT_MINOR, claimed: !!claim, state: claim ? 'confirmed' : intent?.state || 'available', signature: claim?.signature || intent?.signature || null, claimedAt: claim?.created_at || null };
  }
  async claimFaucet(userId: string) {
    this.assertTester(userId);
    const existing = this.store.db.prepare('SELECT amount_minor,signature,created_at FROM pay_faucets WHERE user_id=? AND amount_minor=?').get(userId, DEVNET_FAUCET_AMOUNT_MINOR) as { amount_minor: number; signature: string; created_at: number } | undefined;
    if (existing) return { ...this.faucetStatus(userId), balanceMinor: await this.balanceMinor(userId) };
    this.store.db.prepare('DELETE FROM pay_faucets WHERE user_id=? AND amount_minor!=?').run(userId, DEVNET_FAUCET_AMOUNT_MINOR);
    const faucetId = `faucet:${userId}`;
    const signature = await this.payment(faucetId, userId, 'payout', DEVNET_FAUCET_AMOUNT_MINOR, async () => { const [operating, wallet] = await Promise.all([this.operatingWallet(), this.wallet(userId)]); return [operating, new PublicKey(wallet.address)]; });
    this.store.db.prepare('INSERT OR IGNORE INTO pay_faucets(user_id,amount_minor,signature,created_at) VALUES(?,?,?,?)').run(userId, DEVNET_FAUCET_AMOUNT_MINOR, signature, Date.now());
    return { ...this.faucetStatus(userId), balanceMinor: await this.balanceMinor(userId) };
  }
  async withdraw(userId: string, requestId: string, recipientValue: string, amountMinor: number) { const active = this.withdrawals.get(userId); if (active) await active.catch(() => {}); const task = this.withdrawOnce(userId, requestId, recipientValue, amountMinor); this.withdrawals.set(userId, task); void task.finally(() => { if (this.withdrawals.get(userId) === task) this.withdrawals.delete(userId); }).catch(() => {}); return task; }
  private async withdrawOnce(userId: string, requestId: string, recipientValue: string, amountMinor: number) {
    this.assertTester(userId);
    if (!/^[a-f0-9-]{16,64}$/i.test(requestId)) throw new GameError('Invalid withdrawal request ID');
    if (!Number.isSafeInteger(amountMinor) || amountMinor < WITHDRAWAL_MIN_MINOR || amountMinor > WITHDRAWAL_MAX_MINOR) throw new GameError('Withdrawal must be between 0.10 and 20.00 test USDC');
    let recipient: PublicKey; try { recipient = new PublicKey(recipientValue); } catch { throw new GameError('Enter a valid Solana address'); }
    const existing = this.store.db.prepare('SELECT user_id,recipient,amount_minor,approval_status FROM pay_withdrawals WHERE id=?').get(requestId) as { user_id: string; recipient: string; amount_minor: number; approval_status: string } | undefined;
    if (existing && (existing.user_id !== userId || existing.recipient !== recipient.toBase58() || existing.amount_minor !== amountMinor)) throw new GameError('Withdrawal request ID was already used');
    if (!existing) {
      const since = Date.now() - 86400000;
      const used = Number((this.store.db.prepare(`SELECT COALESCE(SUM(w.amount_minor),0) AS total FROM pay_withdrawals w LEFT JOIN pay_intents i ON i.battle_id=w.id AND i.user_id=w.user_id AND i.kind='withdrawal' WHERE w.user_id=? AND w.created_at>=? AND COALESCE(i.state,'pending')!='failed'`).get(userId, since) as { total: number }).total);
      if (used + amountMinor > WITHDRAWAL_DAILY_LIMIT_MINOR) throw new GameError('Daily withdrawal limit is 100 test USDC');
      const pending = Number((this.store.db.prepare(`SELECT COALESCE(SUM(w.amount_minor),0) AS total FROM pay_withdrawals w LEFT JOIN pay_intents i ON i.battle_id=w.id AND i.user_id=w.user_id AND i.kind='withdrawal' WHERE w.user_id=? AND COALESCE(i.state,'pending')!='failed' AND COALESCE(i.state,'pending')!='confirmed'`).get(userId) as { total: number }).total);
      if (await this.balanceMinor(userId) < pending + amountMinor) throw new GameError('Insufficient test USDC balance');
      const approval = amountMinor > WITHDRAWAL_APPROVAL_THRESHOLD_MINOR ? 'pending' : 'auto';
      this.store.db.prepare('INSERT INTO pay_withdrawals(id,user_id,recipient,amount_minor,created_at,approval_status) VALUES(?,?,?,?,?,?)').run(requestId, userId, recipient.toBase58(), amountMinor, Date.now(), approval);
      this.store.db.prepare("INSERT INTO pay_intents(battle_id,user_id,kind,amount_minor,updated_at) VALUES(?,?, 'withdrawal',?,?)").run(requestId, userId, amountMinor, Date.now());
    }
    const approval = existing?.approval_status || (amountMinor > WITHDRAWAL_APPROVAL_THRESHOLD_MINOR ? 'pending' : 'auto');
    if (approval === 'pending') return { status: 'approval_required' };
    if (approval === 'rejected') throw new GameError('Withdrawal was rejected', 403);
    const signature = await this.payment(requestId, userId, 'withdrawal', amountMinor, async () => [await this.wallet(userId), recipient]); return { status: 'confirmed', signature };
  }
  pendingWithdrawals() { return this.store.db.prepare("SELECT id,recipient,amount_minor AS amountMinor,created_at AS createdAt FROM pay_withdrawals WHERE approval_status='pending' ORDER BY created_at").all(); }
  async decideWithdrawal(id: string, approve: boolean) { const row = this.store.db.prepare('SELECT user_id,recipient,amount_minor,approval_status FROM pay_withdrawals WHERE id=?').get(id) as { user_id: string; recipient: string; amount_minor: number; approval_status: string } | undefined; if (!row) throw new GameError('Withdrawal not found', 404); if (row.approval_status !== 'pending') throw new GameError('Withdrawal was already decided'); this.store.db.prepare('UPDATE pay_withdrawals SET approval_status=?,approved_at=?,approved_by=? WHERE id=?').run(approve ? 'approved' : 'rejected', Date.now(), 'admin', id); if (!approve) { this.store.db.prepare("UPDATE pay_intents SET state='failed',updated_at=? WHERE battle_id=? AND user_id=? AND kind='withdrawal'").run(Date.now(), id, row.user_id); return { status: 'rejected' }; } return this.withdraw(row.user_id, id, row.recipient, row.amount_minor); }
  history(userId: string, limit = 50) {
    this.assertTester(userId);
    return (this.store.db.prepare(`SELECT i.battle_id AS id,i.kind,i.amount_minor AS amountMinor,i.state,i.signature,i.attempt,i.updated_at AS updatedAt,w.recipient FROM pay_intents i LEFT JOIN pay_withdrawals w ON w.id=i.battle_id AND i.kind='withdrawal' WHERE i.user_id=? ORDER BY i.updated_at DESC LIMIT ?`).all(userId, Math.min(100, Math.max(1, limit))) as any[]).map(row => ({ ...row, explorerUrl: row.signature ? `https://explorer.solana.com/tx/${row.signature}?cluster=devnet` : null }));
  }
  async reconcile() {
    const rows = this.store.db.prepare("SELECT * FROM pay_intents WHERE state IN ('pending','signed') ORDER BY updated_at LIMIT 100").all() as PaymentIntent[];
    let recovered = 0, failed = 0;
    for (const row of rows) {
      try {
        if (row.kind === 'withdrawal') { const withdrawal = this.store.db.prepare("SELECT recipient FROM pay_withdrawals WHERE id=? AND approval_status IN ('auto','approved')").get(row.battle_id) as { recipient: string } | undefined; if (!withdrawal) continue; await this.payment(row.battle_id, row.user_id, row.kind, row.amount_minor, async () => [await this.wallet(row.user_id), new PublicKey(withdrawal.recipient)]); }
        else if (row.kind === 'stake') { await this.lockStake(row.battle_id, row.user_id, row.amount_minor); }
        else if (row.kind === 'house') { await this.house(row.battle_id, row.amount_minor); }
        else if (row.kind === 'payout' && row.battle_id === `faucet:${row.user_id}`) { const [operating, wallet] = await Promise.all([this.operatingWallet(), this.wallet(row.user_id)]); const signature = await this.payment(row.battle_id, row.user_id, row.kind, row.amount_minor, async () => [operating, new PublicKey(wallet.address)]); this.store.db.prepare('INSERT OR IGNORE INTO pay_faucets(user_id,amount_minor,signature,created_at) VALUES(?,?,?,?)').run(row.user_id, row.amount_minor, signature, Date.now()); }
        else await this.pay(row.user_id, row.battle_id, row.kind, row.amount_minor);
        recovered++;
      } catch (error) { failed++; console.error('Payment reconciliation:', row.battle_id, row.kind, error); }
    }
    const [escrow, feePayer, operating] = await Promise.all([this.treasuryWallet(), this.feePayerWallet(), this.operatingWallet()]); const escrowAddress = new PublicKey(escrow.address), feePayerAddress = new PublicKey(feePayer.address), operatingAddress = new PublicKey(operating.address), escrowToken = getAssociatedTokenAddressSync(this.mint, escrowAddress), operatingToken = getAssociatedTokenAddressSync(this.mint, operatingAddress);
    let feePayerSolLamports = await this.rpc(connection => connection.getBalance(feePayerAddress, 'confirmed'));
    const lastAirdrop = Number((this.store.db.prepare("SELECT value FROM app_meta WHERE key='fee_payer_airdrop_attempt_at'").get() as { value: string } | undefined)?.value || 0);
    if (feePayerSolLamports < 10_000_000 && Date.now() - lastAirdrop > 3600000) { this.store.db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('fee_payer_airdrop_attempt_at',?)").run(String(Date.now())); try { const signature = await this.fallbackConnection.requestAirdrop(feePayerAddress, 100_000_000); await this.fallbackConnection.confirmTransaction(signature, 'confirmed'); feePayerSolLamports = await this.fallbackConnection.getBalance(feePayerAddress, 'confirmed'); } catch (error) { console.error('Fee payer Devnet funding:', error); } }
    let escrowUsdcMinor = 0, operatingUsdcMinor = 0; try { escrowUsdcMinor = Number((await this.rpc(connection => getAccount(connection, escrowToken))).amount); } catch {} try { operatingUsdcMinor = Number((await this.rpc(connection => getAccount(connection, operatingToken))).amount); } catch {}
    const obligationsMinor = Number((this.store.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS total FROM pay_intents WHERE kind IN ('payout','refund') AND state IN ('pending','signed')").get() as { total: number }).total);
    return { checked: rows.length, recovered, failed, pending: rows.length - recovered, wallets: { feePayer: { address: feePayer.address, solLamports: feePayerSolLamports }, escrow: { address: escrow.address, usdcMinor: escrowUsdcMinor, obligationsMinor }, operating: { address: operating.address, usdcMinor: operatingUsdcMinor } }, approvalQueue: this.pendingWithdrawals().length, alerts: [...(feePayerSolLamports < 10_000_000 ? ['Fee payer SOL is below 0.01 SOL'] : []), ...(escrowUsdcMinor < obligationsMinor ? ['Escrow USDC is below pending payout obligations'] : []), ...(operatingUsdcMinor < DEVNET_FAUCET_AMOUNT_MINOR ? ['Operating wallet has less than 1 test USDC for new-player claims'] : []), ...(this.pendingWithdrawals().length ? [`${this.pendingWithdrawals().length} withdrawal(s) await approval`] : []), ...(failed ? [`${failed} payment reconciliation attempt(s) need attention`] : [])] };
  }
}
