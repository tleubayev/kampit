# SOL Quick Battle

A Telegram group game with synchronized 60-second SOL/USD rounds. XP rooms support 2–100 players; Solana Devnet USDC rooms support 2–10. Players join from a group card, ready up, and pick UP or DOWN during the first 10 seconds. The first ready player starts a 30-second lobby window; at its end, two or more ready players proceed and unready joiners are excluded. Rematch switches the current Mini App window to the new lobby and posts a fresh group card for other players. XP has no monetary value, and Devnet USDC is a test token with no monetary value. Stored predictions retain the internal `LONG` and `SHORT` values for compatibility, while every player-facing surface displays UP and DOWN.

The public root URL presents a responsive Kampit landing page in ordinary browsers. The same URL detects verified Telegram Mini App context and opens the game interface instead, so the existing BotFather configuration does not need to change.

## XP rules

- Each new account starts with 1,000 XP. The September 2026 migration reset existing group XP totals to zero and gave every existing player 1,000 XP. Historical wins and losses remain; the old totals are saved in `stats_before_xp_reset`.
- Existing accounts receive 100 XP at 00:00 UTC each day. If the service is down at midnight, it catches up after restart. Newly created accounts receive their first daily credit at the next midnight.
- A player reserves the room stake when they press **I'm ready**. Winning picks split the entire pool equally; leftover indivisible XP goes to winners in join order. If the start and end prices are equal, the house wins and all staked XP is burned. Void rounds and rounds with no winning picks refund all stakes. An unpicked player forfeits their stake when there is a winning side.
- A user can share their personal referral link from the Mini App or with `/referral` in a private chat. The inviter receives 100 XP once when a new Telegram user starts the bot through that link. Existing users and self-referrals do not award XP.
- The group leaderboard's XP value is each player's net stake result in that group. The Mini App also shows their global spendable XP balance.

## Architecture

One Node.js 24 TypeScript process serves the Telegram webhook, authenticated JSON API, Server-Sent Events, Mini App, round scheduler and Coinbase Exchange SOL-USD ticker feed. SQLite persists battles, players and group stats. Use a **single server instance** with persistent disk; the in-memory sessions and scheduler are not designed for multiple replicas. A price quote older than five seconds cannot start or end a round. A feed outage longer than 15 seconds past the planned finish voids it without XP.

The process rate limits authenticated API traffic to 60 requests per user per minute, state-changing Mini App actions to 10 per user per minute, session creation to 10 per user per minute, and battle requests to 3 per group per minute. Live Server-Sent Event updates do not consume this allowance. Limits are intentionally stored in memory for the single-replica deployment.

## Setup

1. Create a Telegram bot in BotFather. Configure a Mini App with a short name and point it to the public HTTPS URL of this service.
2. Copy `.env.example` to `.env` and fill in the values. The server loads `.env` automatically when present; keep it out of version control. `BOT_USERNAME` omits `@`. Generate a long random `WEBHOOK_SECRET`. Ensure the service can reach `api.telegram.org` and `api.exchange.coinbase.com`.
3. On a Node.js 24 host, run `npm start` (or `node src/server.ts`). No npm dependencies or build step are required. Mount persistent storage for `DATABASE_PATH`.
4. The service registers its webhook and commands at startup. Add the bot to a Telegram group and send `/battle` to choose a stake, or `/battle 25` to set one directly. The creator can start early in the Mini App when at least two players are ready, or use `/cancel` before the countdown. A ready window with fewer than two ready players closes and refunds automatically. Every lobby has a five-minute maximum lifetime, after which a new `/battle` creates a fresh room. Use `/leaderboard`, `/stats`, and `/help` in the group.

The group button uses `https://t.me/BOT_USERNAME/MINI_APP_SHORT_NAME?startapp=BATTLE_ID`. Telegram's group inline `web_app` button is private-chat only, so this direct Mini App link is required. The app validates Telegram `initData` server-side, exchanges it for an HttpOnly session cookie, and keeps the battle identifier separate from identity. Open the link inside Telegram; ordinary browser visits cannot join.

Public API and live-event responses expose `isYou` and `isCreator` flags instead of Telegram user IDs. Telegram user IDs, group chat IDs, referral ownership and database metadata remain server-side.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | BotFather token |
| `BOT_USERNAME` | Bot username without `@` |
| `MINI_APP_SHORT_NAME` | Short name configured in BotFather |
| `APP_URL` | Public HTTPS origin used for webhook registration |
| `WEBHOOK_SECRET` | Random 16+ character Telegram webhook secret |
| `ADMIN_PASSWORD` | Unique 16+ character password for the private `/admin` dashboard; username is `admin`; never reuse `WEBHOOK_SECRET` |
| `DATABASE_PATH` | SQLite file path; default `./battle.sqlite` |
| `PORT` | HTTP port; default `3000` |
| `PAY_MODE_ENABLED` | Enables the allowlisted devnet wallet API when exactly `true` |
| `PAY_MODE_PUBLIC` | Allows all authenticated Telegram users into Devnet pay mode when exactly `true`; otherwise `PAY_MODE_TESTERS` is enforced |
| `SOLANA_CLUSTER` | Must remain `devnet` in this build |
| `SOLANA_RPC_URL` | Solana devnet RPC endpoint |
| `SOLANA_FALLBACK_RPC_URL` | Backup Solana devnet RPC used automatically if the primary RPC fails |
| `PRIVY_APP_ID` | Privy project app ID |
| `PRIVY_APP_SECRET` | Privy server API secret |
| `PRIVY_TREASURY_WALLET_ID` | Privy wallet ID for the treasury after migration (optional during the first migration) |
| `SOLANA_TREASURY_SECRET` | Legacy devnet treasury key, retained only for the one-time Privy import |
| `WALLET_ENCRYPTION_KEY` | Legacy wallet encryption key, retained only while old player wallets are being imported into Privy |
| `WALLET_ENCRYPTION_KEY` | Random 32+ character secret for wallet encryption |
| `PAY_MODE_TESTERS` | Comma-separated Telegram user IDs allowed into the test |

## Hidden Solana pay-mode test

The repository contains a guarded payment layer for invited testers. It is locked to **Solana devnet** and refuses to start with `SOLANA_CLUSTER=mainnet-beta`. The public XP game remains unchanged while `PAY_MODE_ENABLED=false`.

The test layer creates a separate Privy-managed Solana wallet for each allowlisted Telegram account, exposes its wallet and Circle test-USDC token-account addresses through authenticated `GET /api/pay`, and can move test USDC into or out of the treasury. The treasury pays transaction fees, so player wallets do not need devnet SOL. Transfer records have unique battle/user/kind keys to make payment actions idempotent at the application level.

Every stake, payout and refund is stored as a durable payment intent before broadcast. The intent contains the fully signed transaction, deterministic Solana signature, blockhash and expiry height. After a restart, the service checks that signature through both RPC providers and rebroadcasts the same bytes while the blockhash remains valid. It creates a replacement only after expiry and successful absence checks from both providers. This closes the crash window between broadcasting a transfer and recording its result.

Allowlisted testers can withdraw Circle test USDC to any valid Solana Devnet address. Withdrawals use the same crash-safe intent pipeline and expose pending, signed, confirmed and failed states with Solana Explorer links. Limits are 0.10–20 test USDC per request, 100 test USDC per rolling 24 hours, three requests per minute and the available wallet balance. A 30-second reconciliation worker resumes incomplete payments and checks treasury SOL, USDC and pending obligations. Low balances, reconciliation failures and payment backlog appear in the private admin dashboard and service logs.

Custody roles use separate Privy wallets. The fee payer holds SOL only and signs transaction fees; escrow holds player stakes and is the only source for payouts and refunds; the operating treasury receives house-won pools. Withdrawals up to 5 test USDC execute automatically, while larger withdrawals enter an admin approval queue. The overall 20 USDC transaction and 100 USDC rolling daily limits still apply. The admin dashboard shows each role's address/balance health and provides approve/reject controls.

Completed Devnet USDC rounds deduct 1% of the full prize pool to the operating wallet and split the remaining 99% equally among winners. Integer micro-USDC remainder goes to winners deterministically. Void rounds and rounds without a winning prediction refund stakes without a fee. When the end price exactly equals the start price, the house wins and the entire pool moves to the operating wallet.

The build hardcodes Circle's official Solana Devnet USDC mint, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`; an environment variable cannot replace it with a lookalike token. Before enabling pay mode, fund the dedicated treasury with devnet SOL and use [Circle's faucet](https://faucet.circle.com/) to send test USDC to tester wallet addresses. Circle test tokens have no financial value.

Fund the operating wallet from Circle's official faucet to supply welcome claims. Each pay-enabled Telegram account can claim exactly 1 test USDC in the Mini App. Claims are transferred on-chain from the operating wallet, recorded in `pay_faucets`, and recovered idempotently after a restart. Refill the operating wallet whenever its test-USDC balance runs low; the admin dashboard reports an alert below 1 USDC.

This custodial implementation is for closed devnet testing. A mainnet release needs external key management or an embedded-wallet provider, withdrawal controls, reconciliation, abuse controls, legal review, and a security audit.

## Test

Run `npm test` on Node.js 24. Tests cover Telegram auth, stake reservation and payouts, flat-price stake burning, refunds, referral credit, UTC daily grants, legacy XP migration, rematches, and feed outage handling.

## Deployment

Build with `docker build -t sol-quick-battle .`, then run the container behind HTTPS with a persistent volume mounted at `/data` and the required environment variables. Alternatively, run Node.js directly behind a reverse proxy. Set the six required environment variables and use a process supervisor. `/health` reports service and price freshness. For production scaling beyond one process, move sessions and the scheduler to shared coordination and use a hosted database.

## Railway deployment

The service can run on one Railway service with a volume. Deploy the repository's Dockerfile (or upload the local project with `railway up`), keep one replica and Serverless disabled, attach a volume at `/data`, and generate a public domain. Set `DATABASE_PATH=/data/battle.sqlite`, `BOT_USERNAME=Kampit_robot`, `MINI_APP_SHORT_NAME=play`, `APP_URL=https://<generated-domain>`, plus `BOT_TOKEN` and a random `WEBHOOK_SECRET` as service variables. Set the healthcheck path to `/health`. Configure the named Mini App `play` in BotFather with the same HTTPS origin; then restart the service so it registers the webhook.

Set `ADMIN_PASSWORD` to enable the private aggregate dashboard at `/admin`. Log in with username `admin`. The dashboard returns counts and trends only and never exposes Telegram identities.

Security-sensitive production credentials belong in Railway variables or another secret manager, never in a local `.env`, repository, screenshot, or support archive. The Telegram webhook secret authenticates Telegram only and cannot access admin routes. Rotate a credential after any suspected disclosure.

Railway's trial and Free plan have usage limits; monitor usage before relying on the bot for ongoing play. The CLI respects `.gitignore`, and `.railwayignore` independently excludes the local token file from uploads.

### Current Railway project

[Service dashboard](https://railway.com/project/bded0c78-9ce7-44ce-926b-a3eedc83ade2) · [HTTPS app](https://kampit.up.railway.app). This deployment was uploaded with the Railway CLI; GitHub autodeploy is not connected. Run `railway up` from this local project for later releases. The named Mini App `play` belongs to `@Kampit_robot` and must use this HTTPS app URL in BotFather.
