# SOL Quick Battle

A Telegram group game with one mode: synchronized 60-second SOL/USD rounds. Players join from a group card, ready up, and pick LONG or SHORT during the first 10 seconds. Winners earn 100 virtual XP; ties earn 25 XP. No wallet or money flow.

## Architecture

One Node.js 24 TypeScript process serves the Telegram webhook, authenticated JSON API, Server-Sent Events, Mini App, round scheduler and Coinbase Exchange SOL-USD ticker feed. SQLite persists battles, players and group stats. Use a **single server instance** with persistent disk; the in-memory sessions and scheduler are not designed for multiple replicas. A price quote older than five seconds cannot start or end a round. A feed outage longer than 15 seconds past the planned finish voids it without XP.

## Setup

1. Create a Telegram bot in BotFather. Configure a Mini App with a short name and point it to the public HTTPS URL of this service.
2. Copy `.env.example` to `.env` and fill in the values. The server loads `.env` automatically when present; keep it out of version control. `BOT_USERNAME` omits `@`. Generate a long random `WEBHOOK_SECRET`. Ensure the service can reach `api.telegram.org` and `api.exchange.coinbase.com`.
3. On a Node.js 24 host, run `npm start` (or `node src/server.ts`). No npm dependencies or build step are required. Mount persistent storage for `DATABASE_PATH`.
4. The service registers its webhook and commands at startup. Add the bot to a Telegram group and send `/battle`. Use `/leaderboard`, `/stats`, and `/help` in the group.

The group button uses `https://t.me/BOT_USERNAME/MINI_APP_SHORT_NAME?startapp=BATTLE_ID`. Telegram's group inline `web_app` button is private-chat only, so this direct Mini App link is required. The app validates Telegram `initData` server-side, exchanges it for an HttpOnly session cookie, and keeps the battle identifier separate from identity. Open the link inside Telegram; ordinary browser visits cannot join.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | BotFather token |
| `BOT_USERNAME` | Bot username without `@` |
| `MINI_APP_SHORT_NAME` | Short name configured in BotFather |
| `APP_URL` | Public HTTPS origin used for webhook registration |
| `WEBHOOK_SECRET` | Random 16+ character Telegram webhook secret |
| `DATABASE_PATH` | SQLite file path; default `./battle.sqlite` |
| `PORT` | HTTP port; default `3000` |

## Test

Run `npm test` on Node.js 24. Tests cover Telegram auth, lobby readiness, countdown, pick locking, resolution, XP, rematch idempotency and feed outage handling.

## Deployment

Build with `docker build -t sol-quick-battle .`, then run the container behind HTTPS with a persistent volume mounted at `/data` and the required environment variables. Alternatively, run Node.js directly behind a reverse proxy. Set the six required environment variables and use a process supervisor. `/health` reports service and price freshness. For production scaling beyond one process, move sessions and the scheduler to shared coordination and use a hosted database.

## Railway deployment

The service can run on one Railway service with a volume. Deploy the repository's Dockerfile (or upload the local project with `railway up`), keep one replica and Serverless disabled, attach a volume at `/data`, and generate a public domain. Set `DATABASE_PATH=/data/battle.sqlite`, `BOT_USERNAME=Kampit_robot`, `MINI_APP_SHORT_NAME=play`, `APP_URL=https://<generated-domain>`, plus `BOT_TOKEN` and a random `WEBHOOK_SECRET` as service variables. Set the healthcheck path to `/health`. Configure the named Mini App `play` in BotFather with the same HTTPS origin; then restart the service so it registers the webhook.

Railway's trial and Free plan have usage limits; monitor usage before relying on the bot for ongoing play. The CLI respects `.gitignore`, and `.railwayignore` independently excludes the local token file from uploads.
