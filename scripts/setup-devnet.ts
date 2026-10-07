import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import { CIRCLE_SOLANA_DEVNET_USDC_MINT } from '../src/pay-mode.ts';

const output = process.argv[2] || '.pay-devnet.env';
const tester = process.argv[3];
if (!tester || !/^\d+$/.test(tester)) throw new Error('Pass the Telegram tester ID as the second argument');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
let treasury: Keypair, encryptionKey: string;
if (existsSync(output)) {
  const values = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)));
  treasury = Keypair.fromSecretKey(new Uint8Array(Buffer.from(values.SOLANA_TREASURY_SECRET, 'base64'))); encryptionKey = values.WALLET_ENCRYPTION_KEY;
} else {
  treasury = Keypair.generate(); encryptionKey = randomBytes(32).toString('hex');
  writeFileSync(output, [`PAY_MODE_ENABLED=false`, 'SOLANA_CLUSTER=devnet', 'SOLANA_RPC_URL=https://api.devnet.solana.com', `SOLANA_TREASURY_SECRET=${Buffer.from(treasury.secretKey).toString('base64')}`, `WALLET_ENCRYPTION_KEY=${encryptionKey}`, `PAY_MODE_TESTERS=${tester}`, ''].join('\n'), { mode: 0o600 });
}
const balance = await connection.getBalance(treasury.publicKey);
if (balance < 10_000_000) { console.log(JSON.stringify({ cluster: 'devnet', treasury: treasury.publicKey.toBase58(), funded: false, output })); process.exit(2); }
const content = [
  'PAY_MODE_ENABLED=true', 'SOLANA_CLUSTER=devnet', 'SOLANA_RPC_URL=https://api.devnet.solana.com',
  `SOLANA_TREASURY_SECRET=${Buffer.from(treasury.secretKey).toString('base64')}`,
  `WALLET_ENCRYPTION_KEY=${encryptionKey}`, `PAY_MODE_TESTERS=${tester}`, '',
].join('\n');
writeFileSync(output, content, { mode: 0o600 });
console.log(JSON.stringify({ cluster: 'devnet', treasury: treasury.publicKey.toBase58(), mint: CIRCLE_SOLANA_DEVNET_USDC_MINT, tester, output }));
