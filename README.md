# Kampit — BTC Quick Battles in Telegram

[![TON](https://img.shields.io/badge/TON-Testnet-0098EA)](https://ton.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Node.js%2024-3178C6)](https://www.typescriptlang.org/)
[![Telegram](https://img.shields.io/badge/Telegram-Mini%20App-26A5E4)](https://t.me/Kampit_robot)
[![Tests](https://img.shields.io/badge/tests-34%20passing-76f1b0)](#testing)

> Challenge a Telegram group to a synchronized 60-second BTC/USD battle. Pick **UP** or **DOWN**, follow the same live market, and settle the result without leaving the chat.

[Live App](https://kampit.up.railway.app) · [Play in Telegram](https://t.me/Kampit_robot)

<p align="center"><img src="public/kampit-logo.svg" alt="Kampit logo" width="220"></p>

## Game modes

| Mode | Players | Stake | Settlement |
|------|---------|-------|------------|
| Free XP | 2–100 | Minimum 10 XP | Internal XP ledger |
| Testnet GRAM | 2–10 funded players | 0.10–20 test GRAM | TON Testnet |

Both modes use the same Coinbase BTC/USD feed and game flow:

1. Start a battle in a Telegram group.
2. Join and ready up.
3. Pick **UP** or **DOWN** during the first 10 seconds.
4. Watch the price until the 60-second round ends.
5. Receive the result in the Mini App and group chat.
6. Start a rematch in the same Mini App window.

If the end price equals the start price, the house receives the pool. Void rounds refund funded players. Paid winner pools are distributed after a 1% house fee. Testnet GRAM has no monetary value.

## TON payments

Players connect a self-custodial wallet through the official TON Connect interface. Kampit never receives a player's recovery phrase or private key.

Every stake request contains a random, single-use payment ID in its TON message body. A player becomes funded only after the backend independently verifies all of the following on chain:

- TON Testnet network
- Connected sender wallet
- Kampit escrow destination
- Exact GRAM amount
- Expected payment ID
- Unused transaction hash

Payouts, refunds and house transfers use deterministic identifiers and unique database constraints. Reconciliation can safely retry after a restart without intentionally creating a second payment.

Kampit uses three distinct application wallets:

| Wallet | Responsibility |
|--------|----------------|
| Escrow | Receives stakes and sends payouts or refunds |
| Operating | Holds a limited operational fee reserve |
| Treasury | Receives the 1% fee and flat-price house pools |

The three recovery phrases are supplied through the deployment secret manager and are never stored in PostgreSQL or committed to Git.

## Features

- Telegram group bot and Mini App
- Server-authoritative BTC/USD start/end prices and timestamps
- Live chart, synchronized countdown and ten-second prediction window
- XP balances, daily grants, referrals, group statistics and leaderboard
- TON Connect wallet picker
- Native GRAM stakes on TON Testnet
- Ten-player paid-room limit
- Unique on-chain payment references
- 1% paid-game fee and equal winner distribution
- Crash-safe settlement and reconciliation
- Private aggregate admin dashboard
- PostgreSQL persistence, API rate limits and hidden Telegram identifiers

## Architecture

```text
Telegram group ── battle card ──▶ Telegram Mini App
                                      │
                               HTTPS + live SSE
                                      │
                                      ▼
                           Kampit Node.js service
                         bot · API · game · reconciler
                              │              │
                              ▼              ▼
                         PostgreSQL      TON Testnet
                                         TON Connect
                              escrow · operating · treasury
```

The service runs as one application replica. A BTC quote older than five seconds cannot start or resolve a round. If fresh market data does not return within the resolution grace period, the battle is voided.

## Quick start

Prerequisites: Node.js 24+, PostgreSQL, a Telegram bot and a public HTTPS origin.

```bash
git clone https://github.com/tleubayev/kampit.git
cd kampit
pnpm install
cp .env.example .env
pnpm test
pnpm start
```

Bot commands:

```text
/battle           Choose a free XP stake
/battle 50        Create a 50 XP room
/paybattle 0.10   Create a 0.10 Testnet GRAM room
/leaderboard      Show group rankings
/stats            Show personal group statistics
/cancel           Cancel an open lobby
/help             Show game instructions
```

## Configuration

| Variable | Purpose |
|----------|---------|
| `BOT_TOKEN` | Telegram BotFather token |
| `BOT_USERNAME` | Bot username without `@` |
| `MINI_APP_SHORT_NAME` | Mini App short name configured in BotFather |
| `APP_URL` | Public HTTPS application origin |
| `WEBHOOK_SECRET` | Telegram webhook authentication secret |
| `ADMIN_PASSWORD` | Password for the private `/admin` dashboard |
| `DATABASE_BACKEND` | Set to `postgres` in deployment |
| `DATABASE_URL` | PostgreSQL connection string |
| `PAY_MODE_ENABLED` | Enables TON Testnet paid mode |
| `PAY_MODE_PUBLIC` | Makes paid mode available to every authenticated user |
| `PAY_MODE_TESTERS` | Comma-separated Telegram tester IDs |
| `TON_NETWORK` | Must remain `testnet` in this build |
| `TON_RPC_URL` | TON Center-compatible Testnet endpoint |
| `TON_API_KEY` | Dedicated TON Center API key; required when paid mode is enabled |
| `TON_ESCROW_MNEMONIC` | Escrow wallet recovery phrase |
| `TON_OPERATING_MNEMONIC` | Operating wallet recovery phrase |
| `TON_TREASURY_MNEMONIC` | Treasury wallet recovery phrase |

Generate three fresh Testnet wallets locally:

```bash
pnpm setup:ton-testnet .pay-ton-testnet.env YOUR_TELEGRAM_ID
```

The generated file is ignored by Git and created with owner-only permissions. Back it up securely before configuring Railway. Fund the escrow wallet with enough Testnet GRAM for stakes and payout fees, and fund the operating wallet with a small fee reserve.

## Testing

```bash
pnpm test
```

The suite covers Telegram authentication, public-data filtering, rate limits, battle transitions, 100-player free rooms, 10-player paid rooms, XP accounting, referrals, flat-price outcomes, payment distribution, TON role separation, exact stake matching, replay resistance, restart idempotency and PostgreSQL translation.

## Deployment

The repository contains a Railway-compatible Dockerfile and `/health` endpoint. Production requires HTTPS, PostgreSQL, one application replica and the environment variables above.

The TON Connect manifest is served from `/tonconnect-manifest.json`; its icon and URLs must remain publicly reachable over HTTPS.

## Safety status

Paid mode is restricted to TON Testnet. Before any mainnet deployment, Kampit requires an independent smart-contract/payment review, operational monitoring, incident recovery procedures, legal and jurisdictional review, age/country controls and conservative transaction limits.

## Resources

- [TON Connect](https://docs.ton.org/applications/ton-connect/overview)
- [TON payment processing](https://docs.ton.org/applications/payments/overview)
- [Telegram blockchain guidelines](https://core.telegram.org/bots/blockchain-guidelines)
