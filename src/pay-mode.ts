import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrivyClient } from '@privy-io/node';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createMintToCheckedInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import type { Store } from './store.ts';
import { GameError } from './engine.ts';

export type PayConfig = { enabled: boolean; cluster: 'devnet'; rpcUrl: string; usdcMint: string; treasurySecret: string; encryptionKey: string; privyAppId: string; privyAppSecret: string; privyTreasuryWalletId: string; allowedUsers: Set<string> };
type ManagedWallet = { id: string; address: string };
type PrivyWalletClient = { create(input: Record<string, unknown>): Promise<ManagedWallet>; import(input: Record<string, unknown>): Promise<ManagedWallet>; solana(): { signTransaction(walletId: string, input: { transaction: Uint8Array; idempotency_key?: string }): Promise<{ signed_transaction: string }> } };

export function payConfigFromEnv(env = process.env): PayConfig {
  const cluster = env.SOLANA_CLUSTER || 'devnet';
  if (cluster !== 'devnet') throw new Error('Pay mode is locked to Solana devnet in this build');
  return { enabled: env.PAY_MODE_ENABLED === 'true', cluster: 'devnet', rpcUrl: env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', usdcMint: env.TEST_USDC_MINT || '', treasurySecret: env.SOLANA_TREASURY_SECRET || '', encryptionKey: env.WALLET_ENCRYPTION_KEY || '', privyAppId: env.PRIVY_APP_ID || '', privyAppSecret: env.PRIVY_APP_SECRET || '', privyTreasuryWalletId: env.PRIVY_TREASURY_WALLET_ID || '', allowedUsers: new Set((env.PAY_MODE_TESTERS || '').split(',').map(value => value.trim()).filter(Boolean)) };
}
export function validatePayConfig(config: PayConfig) {
  if (!config.enabled) return;
  if (!config.usdcMint || !config.privyAppId || !config.privyAppSecret || !config.allowedUsers.size) throw new Error('Pay mode requires TEST_USDC_MINT, PRIVY_APP_ID, PRIVY_APP_SECRET, and PAY_MODE_TESTERS');
  if (!config.privyTreasuryWalletId && !config.treasurySecret) throw new Error('Set PRIVY_TREASURY_WALLET_ID or temporarily keep SOLANA_TREASURY_SECRET for one-time migration');
  if (config.treasurySecret && config.encryptionKey.length < 32) throw new Error('WALLET_ENCRYPTION_KEY (32+ chars) is required while legacy wallets are being migrated');
  new PublicKey(config.usdcMint); if (config.treasurySecret) decodeKeypair(config.treasurySecret);
}
function cryptoKey(secret: string) { return createHash('sha256').update(secret).digest(); }
export function encryptWallet(secret: Uint8Array, password: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cryptoKey(password), iv); const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]); return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.'); }
export function decryptWallet(value: string, password: string) { const parts = value.split('.'); if (parts.length !== 3) throw new Error('Invalid encrypted wallet'); const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url')); const cipher = createDecipheriv('aes-256-gcm', cryptoKey(password), iv); cipher.setAuthTag(tag); return new Uint8Array(Buffer.concat([cipher.update(encrypted), cipher.final()])); }
export function decodeKeypair(value: string) { const bytes = value.trim().startsWith('[') ? Uint8Array.from(JSON.parse(value)) : new Uint8Array(Buffer.from(value, 'base64')); return Keypair.fromSecretKey(bytes); }

export class DevnetUsdcService {
  connection: Connection; mint: PublicKey; store: Store; config: PayConfig; privy: PrivyWalletClient;
  constructor(store: Store, config: PayConfig, privy?: PrivyWalletClient) { this.store = store; this.config = config; validatePayConfig(config); this.connection = new Connection(config.rpcUrl, 'confirmed'); this.mint = new PublicKey(config.usdcMint); this.privy = privy || (new PrivyClient({ appId: config.privyAppId, appSecret: config.privyAppSecret }).wallets() as unknown as PrivyWalletClient); }
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
  async balanceMinor(userId: string) { try { return Number((await getAccount(this.connection, new PublicKey(await this.depositAddress(userId)))).amount); } catch { return 0; } }
  private async sign(transaction: Transaction, walletIds: string[]) { let bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }); for (const walletId of walletIds) { const signed = await this.privy.solana().signTransaction(walletId, { transaction: bytes, idempotency_key: `kampit-${walletId}-${randomBytes(12).toString('hex')}` }); bytes = Buffer.from(signed.signed_transaction, 'base64'); } return bytes; }
  async faucet(userId: string, amountMinor = 10_000_000) {
    this.assertTester(userId); const prior = this.store.db.prepare('SELECT signature FROM pay_faucets WHERE user_id=?').get(userId) as { signature: string } | undefined; if (prior) return prior.signature;
    const [wallet, treasury] = await Promise.all([this.wallet(userId), this.treasuryWallet()]); const owner = new PublicKey(wallet.address), treasuryAddress = new PublicKey(treasury.address), destination = getAssociatedTokenAddressSync(this.mint, owner), transaction = new Transaction();
    if (!await this.connection.getAccountInfo(destination)) transaction.add(createAssociatedTokenAccountInstruction(treasuryAddress, destination, owner, this.mint)); transaction.add(createMintToCheckedInstruction(this.mint, destination, treasuryAddress, amountMinor, 6)); transaction.feePayer = treasuryAddress; transaction.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    const signature = await this.connection.sendRawTransaction(await this.sign(transaction, [treasury.id])); await this.connection.confirmTransaction(signature, 'confirmed'); this.store.db.prepare('INSERT INTO pay_faucets(user_id,amount_minor,signature,created_at) VALUES(?,?,?,?)').run(userId, amountMinor, signature, Date.now()); return signature;
  }
  private async transfer(owner: ManagedWallet, destinationOwner: PublicKey, amountMinor: number) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new GameError('Invalid USDC amount'); const treasury = await this.treasuryWallet(), treasuryAddress = new PublicKey(treasury.address), ownerAddress = new PublicKey(owner.address); const source = getAssociatedTokenAddressSync(this.mint, ownerAddress), destination = getAssociatedTokenAddressSync(this.mint, destinationOwner), transaction = new Transaction();
    if (!await this.connection.getAccountInfo(destination)) transaction.add(createAssociatedTokenAccountInstruction(treasuryAddress, destination, destinationOwner, this.mint)); transaction.add(createTransferCheckedInstruction(source, this.mint, destination, ownerAddress, amountMinor, 6)); transaction.feePayer = treasuryAddress; transaction.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    const signature = await this.connection.sendRawTransaction(await this.sign(transaction, owner.id === treasury.id ? [treasury.id] : [treasury.id, owner.id]), { skipPreflight: false }); await this.connection.confirmTransaction(signature, 'confirmed'); return signature;
  }
  async lockStake(battleId: string, userId: string, amountMinor: number) { this.assertTester(userId); const prior = this.store.db.prepare("SELECT signature FROM pay_transfers WHERE battle_id=? AND user_id=? AND kind='stake'").get(battleId, userId) as { signature: string } | undefined; if (prior) return prior.signature; const treasury = await this.treasuryWallet(), signature = await this.transfer(await this.wallet(userId), new PublicKey(treasury.address), amountMinor); this.store.db.prepare("INSERT INTO pay_transfers(battle_id,user_id,kind,amount_minor,signature,created_at) VALUES(?,?, 'stake',?,?,?)").run(battleId, userId, amountMinor, signature, Date.now()); return signature; }
  async pay(userId: string, battleId: string, kind: 'payout' | 'refund', amountMinor: number) { const prior = this.store.db.prepare('SELECT signature FROM pay_transfers WHERE battle_id=? AND user_id=? AND kind=?').get(battleId, userId, kind) as { signature: string } | undefined; if (prior) return prior.signature; const [treasury, wallet] = await Promise.all([this.treasuryWallet(), this.wallet(userId)]), signature = await this.transfer(treasury, new PublicKey(wallet.address), amountMinor); this.store.db.prepare('INSERT INTO pay_transfers(battle_id,user_id,kind,amount_minor,signature,created_at) VALUES(?,?,?,?,?,?)').run(battleId, userId, kind, amountMinor, signature, Date.now()); return signature; }
}
