import { existsSync, writeFileSync } from 'node:fs';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';

const output = process.argv[2] || '.pay-ton-testnet.env';
const tester = process.argv[3];
if (!tester || !/^\d+$/.test(tester)) throw new Error('Pass the Telegram tester ID as the second argument');
if (existsSync(output)) throw new Error(`${output} already exists; move it to a secure backup before generating replacement wallets`);

async function wallet() {
  const mnemonic = await mnemonicNew(24), key = await mnemonicToPrivateKey(mnemonic);
  const contract = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey, walletId: { networkGlobalId: -3 } });
  return { mnemonic: mnemonic.join(' '), address: contract.address.toString({ testOnly: true, bounceable: false }) };
}

const [escrow, operating, treasury] = await Promise.all([wallet(), wallet(), wallet()]);
writeFileSync(output, [
  'PAY_MODE_ENABLED=false', 'PAY_MODE_PUBLIC=false', 'TON_NETWORK=testnet',
  'TON_RPC_URL=https://testnet.toncenter.com/api/v2/jsonRPC', 'TON_API_KEY=',
  `TON_ESCROW_MNEMONIC=${JSON.stringify(escrow.mnemonic)}`, `TON_OPERATING_MNEMONIC=${JSON.stringify(operating.mnemonic)}`,
  `TON_TREASURY_MNEMONIC=${JSON.stringify(treasury.mnemonic)}`, `PAY_MODE_TESTERS=${tester}`, '',
].join('\n'), { mode: 0o600 });
console.log(JSON.stringify({ network: 'testnet', escrow: escrow.address, operating: operating.address, treasury: treasury.address, tester, secretBackup: output }, null, 2));
