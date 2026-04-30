# RN Coin Hunt — Telegram Mini App

## Project

Telegram Mini App "RN Coin Hunt" — earn coins by completing tasks (check-in, math quiz, watch ads), withdraw via Telegram bot. Source code lives in `rn-coin-hunt/`. The pnpm workspace `artifacts/` directory is unrelated to this project.

## Architecture

- **Single Express server** (`rn-coin-hunt/server.js`) serves:
  - `/` — landing page
  - `/user-app/` — Telegram Mini App (HTML + Firebase JS SDK)
  - `/admin-panel/` — browser admin panel (HTML + Firebase JS SDK)
  - `/uploads/` — QR code images uploaded by users via Telegram
  - `/config.js` — injects Firebase + bot env vars into the user app
- **Telegram bot** runs **in-process** (`rn-coin-hunt/bot/bot.js` is `require()`d after the HTTP server starts listening). Uses long-polling, so no extra port. Single Render service handles everything.
- **Backend**: Firebase Firestore (client SDK in browser, `firebase-admin` in bot).
- **Deploy**: single Node.js Web Service on Render at `https://miniapp-ytyf.onrender.com`.

## Required environment variables (set in Render)

| Name | Purpose |
|------|---------|
| `BOT_TOKEN` | Telegram bot token |
| `ADMIN_IDS` (or `ADMIN_TELEGRAM_IDS`) | Comma-separated Telegram user IDs of admins |
| `MINI_APP_URL` | Public URL to `/user-app/` |
| `SERVER_URL` | Public root URL (used to build QR upload URLs) |
| `BOT_USERNAME` | Bot username (without @), for referral links |
| `FIREBASE_SERVICE_ACCOUNT` | Full service account JSON (one line) for `firebase-admin` |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID` | For client SDK (served by `/config.js`) |

In Replit dev environment these aren't set, so the bot disables itself but the HTTP server still runs.

## Firestore collections

- `users/{uid}` — `name`, `email`, `balance`, `telegramId`, `isBlocked`, etc.
- `withdrawals/{id}` — `userId`, `userName`, `userEmail`, `telegramId`, `amount`, `method`, `accountName`, `qrCodeUrl` (relative `/uploads/...`), `upiId` (app-only), `source` (`bot` / `app`), `status` (`pending` / `approved` / `rejected` / `binned`), `requestedAt`, `binnedAt`, `processedAt`, `reason`
- `coupons/{id}` — `code`, `totalUses`, `coinsPerUser`, `usedCount`, `usedBy[]`, `createdAt`, `createdBy`
- `notifications/{id}` — broadcast (browser admin → all users)
- `user_notifications/{id}` — per-user (`userId`, `type`, `title`, `message`, `createdAt`)
- `config/main` — app settings:
  - Limits/cooldowns: `dailyAdLimit`, `adCooldown`, `dailyMathLimit`, `mathCooldown`
  - Rewards: `checkinReward`, `referralBonus`, `adReward`, `mathReward`
  - Withdrawal: `minWithdrawal`, `coinValueCoins`, `coinValueInr`, `paymentMethods[]`, `withdrawalOptions[]`
  - **Bot buttons**: `channelLink`, `helpLink`, `policyText`
  - Ads: `monetagScript`, `monetagAdFn`, `customHeadCode`

Recommended dev rule (until proper rules are written): `allow read, write: if request.auth != null;`

## Telegram bot features

### User menu (`/start`)
Inline grid: Tasks (web app) · Balance · Withdraw · Claim Coupon · Join Channel · Help · My ID · Policy. Each detail screen has a "← Back to Menu" button.

- **Balance** → shows balance/value with Withdraw + History + Back buttons
- **Withdraw** → multi-step: amount → method → QR upload → account name → submit (saved with `source: 'bot'`)
- **History** → paginated 5-per-page list, status icons (⏳ pending / ✅ approved / ❌ rejected/binned), latest at bottom, Previous/Next/Back keyboard
- **Claim Coupon** → user types code; bot validates against `coupons` collection, increments balance
- **Join Channel / Help / Policy** → reads `channelLink` / `helpLink` / `policyText` from `config/main`
- **My ID** → shows Telegram ID + linked account info

Bot has only `/start` in its commands menu — everything else is button-driven.

### Admin panel (`/admin`, only ADMIN_IDS allowed)
Inline-button menu:
- **⏳ Pending Withdrawals** → one-by-one with Accept / Reject / Skip / 🗑️ To Bin + count
- **🗑️ Bin Requests** → one-by-one with Skip / ↩️ Return
- **📢 Broadcast** — admin sends any message (text/photo/video/audio/voice/document) → bot relays via `copyMessage` to every user with a linked `telegramId`
- **👤 Message User** — admin enters target ID, then sends a message; bot copies it to that user
- **🎟️ Create Coupon** — 3-step wizard: total uses → coins per user → code (or "auto")
- **📊 Stats** — counts of users / pending / approved / binned / coupons

State machines per admin in memory (`adminState`, `adminSkipped`, `adminBinSkipped`).

## Browser admin panel (`/admin-panel/`)

Sections: Dashboard · Users · Withdrawals · **Bin Requests** · **Coupons** · Notifications · Settings.

- **Withdrawals** query uses only `where status==pending` (NO `orderBy`) and sorts client-side. Reason: composite `where + orderBy` requires a Firestore index that often isn't created. Same approach for Bin Requests.
- **Withdrawals row actions**: Approve / Reject / 🗑️ Bin
- **Bin Requests**: ↩️ Return moves status back to `pending`
- **QR / UPI cell**: `qrCellHtml()` resolves relative `qrCodeUrl` against `window.location.origin`, falls back to a "📱 UPI: ..." badge for app-source withdrawals (no QR), and shows "Image unavailable" on `onerror`. Each row also gets a 🤖 Bot / 📱 App source badge.
- **Coupons** page: create form (code/uses/coins) + live list + Delete (soft-disable by setting `totalUses: 0`)
- **Settings → App Settings** now includes:
  - Withdrawal block (min, exchange rate, payment methods, withdrawal amounts)
  - **Bot Buttons block**: Channel Link, Help Link, Policy Text — these power the bot's Join Channel / Help / Policy buttons

All UI text is English.

## Workflow

The pre-configured workflow `Start application` runs `node rn-coin-hunt/server.js`. The bot starts in the same process after the server begins listening.

The `artifacts/api-server` and `artifacts/mockup-sandbox` workflows are unrelated leftover scaffolding from the pnpm workspace template — ignore them for this project.
