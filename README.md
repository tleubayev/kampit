# Kampit — SOL Quick Battles in Telegram

[![Solana](https://img.shields.io/badge/Solana-devnet-9945FF)](https://solana.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-Node.js%2024-3178C6)](https://www.typescriptlang.org/)
[![Telegram](https://img.shields.io/badge/Telegram-Mini%20App-26A5E4)](https://t.me/Kampit_robot)
[![Tests](https://img.shields.io/badge/tests-38%20passing-76f1b0)](#testing)

> Challenge a Telegram group to a synchronized 60-second SOL/USD battle. Pick **UP** or **DOWN**, follow the live market, and settle the result without leaving the chat.

[Live App](https://kampit.up.railway.app) · [Play in Telegram](https://t.me/Kampit_robot) · [Architecture](#architecture) · [Quick Start](#quick-start)

---

<p align="center">
  <img src="public/kampit-logo.svg" alt="Kampit logo" width="220">
</p>

---

## Problem and Solution

### 1. Trading games are difficult to coordinate

- **Problem:** Players use different charts, prices, and timers, making a fair group prediction game hard to run.
- **Kampit:** Every player shares one server-authoritative start price, end price, and 60-second clock.

### 2. Group games have too much setup

- **Problem:** Moving users from a Telegram chat into a separate product breaks the social flow.
- **Kampit:** A group member starts a room with `/battle` or `/paybattle`; everyone joins through the posted Telegram battle card.

### 3. On-chain settlement can fail in subtle ways

- **Problem:** RPC errors, restarts, duplicate broadcasts, and partially funded lobbies can produce incorrect payments.
- **Kampit:** Durable payment intents, deterministic signatures, idempotent transfers, reconciliation, RPC fallback, and orphan-stake recovery make Devnet settlement restart-safe.

### 4. New users need a simple entry point

- **Problem:** Requiring wallets and tokens before users understand the game creates friction.
- **Kampit:** Free XP mode works immediately. Devnet mode creates a Privy-managed Solana wallet and provides a one-time 1 test-USDC welcome claim.

---

## Game Modes

| Mode | Players | Stake | Settlement |
|------|---------|-------|------------|
| Free XP | 2–100 | Minimum 10 XP | Internal XP ledger |
| Devnet USDC | 2–10 funded players | Minimum 0.10 test USDC | Solana Devnet |

Both modes use the same live SOL/USD feed and game flow:

1. Create a battle in a Telegram group.
2. Join and ready up.
3. Pick **UP** or **DOWN** during the first 10 seconds.
4. Watch the price until the 60-second round ends.
5. Receive the result in the Mini App and group chat.
6. Start a rematch in the same Mini App window.

### Outcome rules

- If the end price is higher, **UP** wins.
- If the end price is lower, **DOWN** wins.
- If both prices are equal, the house wins the pool.
- A void round refunds eligible stakes.
- A paid winner pool is distributed after a 1% house fee.
- A confirmed paid stake that misses lobby admission is refunded automatically.

Test USDC on Devnet has no monetary value.

---

## Why Solana

- **Fast confirmation** — a good fit for short, synchronized game rounds.
- **Low transaction cost** — supports small test stakes and multiple winner payouts.
- **USDC support** — Kampit uses Circle's official Solana Devnet USDC mint.
- **Transparent settlement** — deposits, payouts, refunds, and withdrawals can be verified on-chain.
- **Wallet infrastructure** — Privy provides managed Solana wallets without exposing private keys to the Kampit application database.

---

## Summary of Features

- Telegram group bot and Mini App
- Server-authoritative 60-second SOL/USD rounds
- Ten-second prediction window
- UP and DOWN predictions
- Live chart and synchronized countdown
- XP balances, daily grants, referrals, statistics, and group leaderboard
- Up to 100 players in free rooms
- Up to 10 funded players in Devnet rooms
- Privy-managed Solana wallets
- One-time 1 test-USDC welcome claim
- Circle official Devnet USDC mint locked in code
- Deposits, withdrawals, transaction states, and Explorer links
- 1% paid-game fee with equal winner distribution
- Separate fee payer, escrow, and operating wallets
- Withdrawal limits and approval queue
- Crash-safe, idempotent payment intents
- Primary and fallback Solana RPC providers
- Payment reconciliation and treasury alerts
- Private aggregate admin dashboard
- PostgreSQL persistence
- API rate limits and hidden Telegram identifiers

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Telegram | Bot API · Mini Apps · signed `initData` authentication |
| Frontend | HTML · CSS · browser JavaScript · Canvas |
| Backend | Node.js 24 · TypeScript · Server-Sent Events |
| Database | PostgreSQL |
| Market data | Coinbase Exchange SOL/USD feed |
| Blockchain | Solana Devnet · `@solana/web3.js` · SPL Token |
| Wallets | Privy server-managed Solana wallets |
| Stablecoin | Circle Devnet USDC |
| RPC | Helius primary endpoint · fallback provider |
| Hosting | Railway · Docker |
| Testing | Node.js test runner |

---

## Architecture

```text
┌──────────────────────┐      ┌────────────────────────────┐
│ Telegram Group       │      │ Telegram Mini App          │
│ /battle · /paybattle │─────▶│ Lobby · Chart · UP / DOWN  │
└──────────┬───────────┘      └──────────────┬─────────────┘
           │                                  │ HTTPS + SSE
           └────────────────┬─────────────────┘
                            ▼
              ┌──────────────────────────┐
              │ Kampit Node.js Service   │
              │ Bot · API · Game Engine  │
              │ Scheduler · Reconciler   │
              └──────┬──────────┬────────┘
                     │          │
              ┌──────▼─────┐    └──────────────┐
              │ PostgreSQL │                   │
              │ Game state │                   ▼
              │ Payments   │       ┌──────────────────────┐
              └────────────┘       │ Solana Devnet        │
                                   │ Privy · Helius · USDC │
                                   └──────────────────────┘
```

The service currently runs as one application replica. PostgreSQL stores durable game and payment state; Server-Sent Events distribute live updates. A quote older than five seconds cannot start or resolve a round. If fresh market data does not return within the resolution grace period, the round is voided.

### Payment safety

Each stake, payout, refund, recovery, welcome claim, and withdrawal is represented by a durable payment intent. Signed transaction bytes and the deterministic Solana signature are stored before broadcast. After a restart, Kampit verifies and rebroadcasts the same transaction while its blockhash remains valid, preventing duplicate payment creation.

Paid lobbies pause while a stake confirmation is in progress. The 30-second paid lobby timer begins after two stakes confirm, and every room has a five-minute maximum lifetime. Only ready, funded players enter the prize pool.

---

## Quick Start

**Prerequisites:** Node.js 24+, PostgreSQL, a Telegram bot, and HTTPS for Telegram Mini App testing.

```bash
# Clone the repository
git clone https://github.com/tleubayev/kampit.git
cd kampit

# Install dependencies
npm install

# Configure the application
cp .env.example .env

# Run tests
npm test

# Start the service
npm start
```

Add the bot to a Telegram group and use:

```text
/battle           Choose a free XP stake
/battle 50        Create a 50 XP room
/paybattle 0.10   Create a 0.10 Devnet USDC room
/leaderboard      Show group rankings
/stats            Show personal group statistics
/cancel           Cancel your open lobby
/help             Show game instructions
```

---

## Configuration

Copy `.env.example` to `.env`. Never commit the populated file.

| Variable | Purpose |
|----------|---------|
| `BOT_TOKEN` | Telegram BotFather token |
| `BOT_USERNAME` | Bot username without `@` |
| `MINI_APP_SHORT_NAME` | Mini App short name configured in BotFather |
| `APP_URL` | Public HTTPS application origin |
| `WEBHOOK_SECRET` | Telegram webhook authentication secret |
| `ADMIN_PASSWORD` | Password for the private `/admin` dashboard |
| `DATABASE_BACKEND` | Set to `postgres` for the deployed architecture |
| `DATABASE_URL` | PostgreSQL connection string |
| `PAY_MODE_ENABLED` | Enables Devnet payment features when `true` |
| `PAY_MODE_PUBLIC` | Enables Devnet mode for all authenticated users |
| `PAY_MODE_TESTERS` | Comma-separated tester IDs when public mode is disabled |
| `SOLANA_CLUSTER` | Must remain `devnet` in this build |
| `SOLANA_RPC_URL` | Private primary Devnet RPC endpoint |
| `SOLANA_FALLBACK_RPC_URL` | Fallback Devnet RPC endpoint |
| `PRIVY_APP_ID` | Privy application ID |
| `PRIVY_APP_SECRET` | Privy server secret |
| `PRIVY_TREASURY_WALLET_ID` | Privy escrow wallet ID |

Secrets belong in Railway variables or another secret manager. The repository ignores `.env`, local databases, and Devnet setup files.

---

## Testing

```bash
npm test
```

The test suite covers Telegram authentication, public-data filtering, rate limits, lobby transitions, 100-player free rooms, 10-player paid rooms, XP accounting, referrals, flat-price outcomes, paid distribution, faucet claims, withdrawals, Privy wallet migration, PostgreSQL translation, restart recovery, and orphan-stake protection.

---

## Deployment

The repository includes a Dockerfile and Railway-compatible entrypoint.

```bash
docker build -t kampit .
docker run --env-file .env -p 3000:3000 kampit
```

Production requires HTTPS, PostgreSQL, one application replica, and the environment variables above. Set the health-check path to `/health`. The endpoint reports service availability and market-feed freshness.

The public landing page and Telegram Mini App share the same origin. Ordinary browser visits show the landing page; verified Telegram Mini App sessions open the game.

---

## Roadmap

- [x] Telegram group battles and Mini App
- [x] Free XP mode with leaderboards and referrals
- [x] Privy-managed Solana wallets
- [x] Circle Devnet USDC deposits and withdrawals
- [x] Crash-safe paid settlement and reconciliation
- [x] Separate fee payer, escrow, and operating wallets
- [x] PostgreSQL persistence and private admin dashboard
- [x] Ten-player paid-room safeguards
- [ ] Extended multi-user load testing
- [ ] Independent security audit
- [ ] Legal and compliance review
- [ ] Mainnet pilot with conservative limits
- [ ] Mainnet public release

---

## Resources

- [Live Landing Page](https://kampit.up.railway.app)
- [Telegram Bot](https://t.me/Kampit_robot)
- [Solana Documentation](https://solana.com/docs)
- [Privy Documentation](https://docs.privy.io/)
- [Circle Testnet Faucet](https://faucet.circle.com/)

---

## Mainnet Status

Kampit's payment mode is restricted to Solana Devnet. Devnet tokens have no financial value. A mainnet launch requires an independent security review, operational monitoring, recovery procedures, legal review, and explicit production limits.
