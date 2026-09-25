# SOL Quick Battle

A Telegram group game with one mode: synchronized 60-second SOL/USD rounds for 2–100 players. Players join from a group card, ready up, and pick LONG or SHORT during the first 10 seconds. The first ready player starts a 30-second lobby window; at its end, two or more ready players proceed and unready joiners are excluded. Rematch switches the current Mini App window to the new lobby and posts a fresh group card for other players. Rooms have a creator-selected virtual XP stake of at least 10. There are no deposits, real-money stakes, or prizes.

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
| `ADMIN_PASSWORD` | Password for the private `/admin` dashboard; username is `admin` |
| `DATABASE_PATH` | SQLite file path; default `./battle.sqlite` |
| `PORT` | HTTP port; default `3000` |

## Test

Run `npm test` on Node.js 24. Tests cover Telegram auth, stake reservation and payouts, flat-price stake burning, refunds, referral credit, UTC daily grants, legacy XP migration, rematches, and feed outage handling.

## Deployment

Build with `docker build -t sol-quick-battle .`, then run the container behind HTTPS with a persistent volume mounted at `/data` and the required environment variables. Alternatively, run Node.js directly behind a reverse proxy. Set the six required environment variables and use a process supervisor. `/health` reports service and price freshness. For production scaling beyond one process, move sessions and the scheduler to shared coordination and use a hosted database.

## Railway deployment

The service can run on one Railway service with a volume. Deploy the repository's Dockerfile (or upload the local project with `railway up`), keep one replica and Serverless disabled, attach a volume at `/data`, and generate a public domain. Set `DATABASE_PATH=/data/battle.sqlite`, `BOT_USERNAME=Kampit_robot`, `MINI_APP_SHORT_NAME=play`, `APP_URL=https://<generated-domain>`, plus `BOT_TOKEN` and a random `WEBHOOK_SECRET` as service variables. Set the healthcheck path to `/health`. Configure the named Mini App `play` in BotFather with the same HTTPS origin; then restart the service so it registers the webhook.

Set `ADMIN_PASSWORD` to enable the private aggregate dashboard at `/admin`. Log in with username `admin`. The dashboard returns counts and trends only and never exposes Telegram identities.

Railway's trial and Free plan have usage limits; monitor usage before relying on the bot for ongoing play. The CLI respects `.gitignore`, and `.railwayignore` independently excludes the local token file from uploads.

### Current Railway project

[Service dashboard](https://railway.com/project/bded0c78-9ce7-44ce-926b-a3eedc83ade2) · [HTTPS app](https://kampit.up.railway.app). This deployment was uploaded with the Railway CLI; GitHub autodeploy is not connected. Run `railway up` from this local project for later releases. The named Mini App `play` belongs to `@Kampit_robot` and must use this HTTPS app URL in BotFather.
