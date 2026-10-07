import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrivyClient } from '@privy-io/node';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import type { Store } from './store.ts';
import { GameError } from './engine.ts';

export const CIRCLE_SOLANA_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export type PayConfig = { enabled: boolean; cluster: 'devnet'; rpcUrl: string; fallbackRpcUrl: string; treasurySecret: string; encryptionKey: string; privyAppId: string; privyAppSecret: string; privyTreasuryWalletId: string; allowedUsers: Set<string> };
type ManagedWallet = { id: string; address: string };
type PaymentKind = 'stake' | 'payout' | 'refund';
type PaymentIntent = { battle_id: string; user_id: string; kind: PaymentKind; amount_minor: number; state: 'pending' | 'signed' | 'confirmed'; signature: string | null; raw_transaction: string | null; blockhash: string | null; last_valid_block_height: number | null; attempt: number };
type PrivyWalletClient = { create(input: Record<string, unknown>): Promise<ManagedWallet>; import(input: Record<string, unknown>): Promise<ManagedWallet>; solana(): { signTransaction(walletId: string, input: { transaction: Uint8Array; idempotency_key?: string }): Promise<{ signed_transaction: string }> } };

export function payConfigFromEnv(env = process.env): PayConfig {
  const cluster = env.SOLANA_CLUSTER || 'devnet';
  if (cluster !== 'devnet') throw new Error('Pay mode is locked to Solana devnet in this build');
  return { enabled: env.PAY_MODE_ENABLED === 'true', cluster: 'devnet', rpcUrl: env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', fallbackRpcUrl: env.SOLANA_FALLBACK_RPC_URL || 'https://api.devnet.solana.com', treasurySecret: env.SOLANA_TREASURY_SECRET || '', encryptionKey: env.WALLET_ENCRYPTION_KEY || '', privyAppId: env.PRIVY_APP_ID || '', privyAppSecret: env.PRIVY_APP_SECRET || '', privyTreasuryWalletId: env.PRIVY_TREASURY_WALLET_ID || '', allowedUsers: new Set((env.PAY_MODE_TESTERS || '').split(',').map(value => value.trim()).filter(Boolean)) };
}
export function validatePayConfig(config: PayConfig) {
  if (!config.enabled) return;
  if (!config.privyAppId || !config.privyAppSecret || !config.allowedUsers.size) throw new Error('Pay mode requires PRIVY_APP_ID, PRIVY_APP_SECRET, and PAY_MODE_TESTERS');
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
  assertTester(userId: string) { if (!this.config.enabled || !this.config.allowedUsers.has(userId)) throw new GameError('Test pay mode is not enabled for this account', 403); }
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
  async depositAddress(userId: string) { return getAssociatedTokenAddressSync(this.mint, new PublicKey((await this.wallet(userId)).address)).toBase58(); }
  async balanceMinor(userId: string) { const address = new PublicKey(await this.depositAddress(userId)); try { return Number((await this.rpc(connection => getAccount(connection, address))).amount); } catch { return 0; } }
  private async sign(transaction: Transaction, walletIds: string[]) { let bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }); for (const walletId of walletIds) { const signed = await this.privy.solana().signTransaction(walletId, { transaction: bytes, idempotency_key: `kampit-${walletId}-${randomBytes(12).toString('hex')}` }); bytes = Buffer.from(signed.signed_transaction, 'base64'); } return bytes; }
  private intent(battleId: string, userId: string, kind: PaymentKind) { return this.store.db.prepare('SELECT * FROM pay_intents WHERE battle_id=? AND user_id=? AND kind=?').get(battleId, userId, kind) as PaymentIntent | undefined; }
  private async confirmed(signature: string, requireEveryProvider = false) { const providers = this.config.fallbackRpcUrl === this.config.rpcUrl ? [this.connection] : [this.connection, this.fallbackConnection]; let checked = 0, lastError: unknown; for (const connection of providers) { try { const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]; checked++; if (status?.err) throw new Error(`Solana transaction ${signature} failed`); if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return true; } catch (error) { lastError = error; } } if (!checked || (requireEveryProvider && checked !== providers.length)) throw lastError || new Error('Could not verify payment signature with every RPC provider'); return false; }
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
    const treasury = await this.treasuryWallet(), treasuryAddress = new PublicKey(treasury.address), ownerAddress = new PublicKey(owner.address); const source = getAssociatedTokenAddressSync(this.mint, ownerAddress), destination = getAssociatedTokenAddressSync(this.mint, destinationOwner), transaction = new Transaction();
    if (!await this.rpc(connection => connection.getAccountInfo(destination))) transaction.add(createAssociatedTokenAccountInstruction(treasuryAddress, destination, destinationOwner, this.mint)); transaction.add(createTransferCheckedInstruction(source, this.mint, destination, ownerAddress, intent.amount_minor, 6)); transaction.feePayer = treasuryAddress;
    const latest = await this.rpc(connection => connection.getLatestBlockhash('confirmed')); transaction.recentBlockhash = latest.blockhash;
    const signed = await this.sign(transaction, owner.id === treasury.id ? [treasury.id] : [treasury.id, owner.id]); const decoded = Transaction.from(signed); const signatureBytes = decoded.signatures[0]?.signature; if (!signatureBytes) throw new Error('Signed Solana transaction has no fee-payer signature'); const signature = base58(signatureBytes);
    this.store.db.prepare("UPDATE pay_intents SET state='signed',signature=?,raw_transaction=?,blockhash=?,last_valid_block_height=?,attempt=attempt+1,updated_at=? WHERE battle_id=? AND user_id=? AND kind=?").run(signature, Buffer.from(signed).toString('base64'), latest.blockhash, latest.lastValidBlockHeight, Date.now(), intent.battle_id, intent.user_id, intent.kind);
    const signedIntent = this.intent(intent.battle_id, intent.user_id, intent.kind)!;
    try { await this.rpc(connection => connection.sendRawTransaction(signed, { skipPreflight: false, maxRetries: 3 })); } catch { if (!await this.confirmed(signature)) throw new Error('Payment broadcast is pending; retrying safely'); }
    await this.rpc(connection => connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed'));
    this.recordConfirmed(signedIntent, signature); return signature;
  }
  private payment(battleId: string, userId: string, kind: PaymentKind, amountMinor: number, resolveParties: () => Promise<[ManagedWallet, PublicKey]>) { if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new GameError('Invalid USDC amount'); const key = `${battleId}:${userId}:${kind}`; const active = this.payments.get(key); if (active) return active; const task = (async () => { const prior = this.store.db.prepare('SELECT amount_minor,signature FROM pay_transfers WHERE battle_id=? AND user_id=? AND kind=?').get(battleId, userId, kind) as { amount_minor: number; signature: string } | undefined; if (prior) { if (prior.amount_minor !== amountMinor) throw new Error('Recorded payment amount mismatch'); this.store.db.prepare("INSERT OR IGNORE INTO pay_intents(battle_id,user_id,kind,amount_minor,state,signature,updated_at) VALUES(?,?,?,?,'confirmed',?,?)").run(battleId, userId, kind, amountMinor, prior.signature, Date.now()); return prior.signature; } this.store.db.prepare('INSERT OR IGNORE INTO pay_intents(battle_id,user_id,kind,amount_minor,updated_at) VALUES(?,?,?,?,?)').run(battleId, userId, kind, amountMinor, Date.now()); const intent = this.intent(battleId, userId, kind)!; if (intent.amount_minor !== amountMinor) throw new Error('Payment intent amount mismatch'); const [owner, destination] = await resolveParties(); return this.executePayment(intent, owner, destination); })(); this.payments.set(key, task); void task.finally(() => this.payments.delete(key)).catch(() => {}); return task; }
  async lockStake(battleId: string, userId: string, amountMinor: number) { this.assertTester(userId); return this.payment(battleId, userId, 'stake', amountMinor, async () => { const treasury = await this.treasuryWallet(); return [await this.wallet(userId), new PublicKey(treasury.address)]; }); }
  async pay(userId: string, battleId: string, kind: 'payout' | 'refund', amountMinor: number) { return this.payment(battleId, userId, kind, amountMinor, async () => { const [treasury, wallet] = await Promise.all([this.treasuryWallet(), this.wallet(userId)]); return [treasury, new PublicKey(wallet.address)]; }); }
}
