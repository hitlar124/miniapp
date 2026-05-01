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

- `users/{uid}` — `name`, `email`, `balance`, `telegramId`, `isBlocked`, `deviceFingerprint`, etc.
- `withdrawals/{id}` — `userId`, `userName`, `userEmail`, `telegramId`, `amount`, `method`, `accountName`, `qrCodeUrl` (relative `/uploads/...`), `upiId` (app-only), `source` (`bot` / `app`), `status` (`pending` / `approved` / `rejected` / `binned`), `requestedAt`, `binnedAt`, `processedAt`, `reason`
- `coupons/{id}` — `code`, `totalUses`, `coinsPerUser`, `usedCount`, `usedBy[]`, `createdAt`, `createdBy`
- `notifications/{id}` — broadcast (browser admin → all users)
- `user_notifications/{id}` — per-user (`userId`, `type`, `title`, `message`, `createdAt`)
- `config/main` — app settings:
  - Limits/cooldowns: `dailyAdLimit`, `adCooldown`, `dailyMathLimit`, `mathCooldown`
  - Rewards: `checkinReward`, `referralBonus`, `adReward`, `mathReward`, `referralCommission` (%)
  - Withdrawal: `minWithdrawal`, `coinValueCoins`, `coinValueInr`, `paymentMethods[]`, `withdrawalOptions[]`
  - **Bot buttons**: `channelLink`, `helpLink`, `policyText`
  - Ads: `monetagScript`, `monetagAdFn`, `monetagPopupFn`, `customHeadCode`
  - **App controls**: `appEnabled` (bool, default true), `adBlockerCheck` (bool, default true)

Recommended dev rule (until proper rules are written): `allow read, write: if request.auth != null;`

## Telegram bot features

### User app (`/user-app/`) — earn flows

All four "Earn Coins" tasks gate the reward behind a Monetag video ad (via `playMonetagAd()`):

1. **Daily Check-in** → ad plays first, then `+checkinReward` once per day.
2. **Math Quiz** → 2-digit numbers (10–99), only `+` and `-`. On a correct answer, ad plays first, then `+mathReward`.
3. **Watch Video Ad** → ad plays, then `+adReward`.
4. **Claim Coupon** → user enters a code, ad plays, then `+coinsPerUser` is added.

### Ad / maintenance features

- **Ad load failure**: `playMonetagAd()` has a 30-second timeout. On timeout or SDK missing, shows "Network slow, please try again later."
- **Ad blocker detection**: `detectAdBlocker()` runs on app load (background). Skipped if `appConfig.adBlockerCheck === false`. Shows `#adblock-modal` if detected.
- **Maintenance mode**: if `config/main.appEnabled === false`, the user app shows maintenance message after login, bot non-admins get maintenance message on `/start`.
- **One account per device**: on sign-up, a device fingerprint (`fp_<hash>` of navigator/screen info) is computed and checked against `deviceFingerprint` field in existing user docs. Duplicate devices blocked.

### Withdrawal (in-app, UPI)

- All `withdrawalOptions` from `config/main` are shown regardless of balance. Amounts above balance are muted.
- A user with **any** withdrawal in `pending` or `binned` status cannot submit a new one.

### Telegram bot user menu (`/start`)

Inline grid: Tasks (web app) · Balance · Withdraw · Claim Coupon · Join Channel · Help · My ID · Policy.

- **Balance** → shows balance/value with Withdraw + History + Back buttons
- **Withdraw** → multi-step: amount → method → QR upload → account name → submit (`source: 'bot'`)
- **History** → paginated 5-per-page list
- **Claim Coupon** → user types code; bot validates against `coupons` collection
- **Join Channel / Help / Policy** → reads `channelLink` / `helpLink` / `policyText` from `config/main`
- **My ID** → shows Telegram ID + linked account info
- **Maintenance mode**: if `config/main.appEnabled === false`, non-admins see maintenance message

Bot `/start` ban/unban uses **email** (not Telegram ID).

### Admin panel (`/admin`, only ADMIN_IDS allowed)

Inline-button menu (2-per-row):
- **⏳ Pending Withdrawals** → Accept / Reject / Skip / 🗑️ To Bin
- **🗑️ Bin Requests** → Skip / ↩️ Return
- **📢 Broadcast** — relays any message to all users via `copyMessage`
- **👤 Message User** — admin sends to specific user
- **🎟️ Create Coupon** — 3-step wizard
- **📊 Stats** — user/withdrawal/coupon counts
- **🚫 Ban User / ✅ Unban User** — by **email address**

## Browser admin panel (`/admin-panel/`)

Sections: Dashboard · Users · Withdrawals · Bin Requests · Coupons · Notifications · **Banned Users** · Settings.

- **Login**: username/password only. Firebase config set from Settings → Firebase Config.
- **Server-side admin API** (`/api/admin/*`): broadcast, adjust-coins, ban-user, notify-user.
- **Users page**: filter tabs (All / Active / **Inactive** / Blocked). Inactive = balance 0 and not blocked.
- **Banned Users page**: dedicated page listing all blocked users, search by email, one-click Unban.
- **Withdrawals**: search bar to filter by name/email. Approve/Reject sends Telegram notification via `/api/admin/notify-user`.
- **Withdrawals** query: `where status==pending` only, sorted client-side (avoids composite index requirement).
- **Bin Requests**: ↩️ Return moves status back to `pending`.
- **Coupons** page: create form + live list + Delete (soft-disable).
- **Settings → App Settings**: rewards, limits, withdrawal config, Bot Buttons, Referral Commission, plus:
  - 🟢 **App Enabled** toggle (`appEnabled` field) — turns on/off maintenance mode
  - 🛡️ **Ad Blocker Detection** toggle (`adBlockerCheck` field) — enable/disable ad blocker enforcement

All UI text is English.

## Workflow

The pre-configured workflow `Start application` runs `node rn-coin-hunt/server.js`. The bot starts in the same process after the server begins listening.

The `artifacts/api-server` and `artifacts/mockup-sandbox` workflows are unrelated leftover scaffolding — ignore them.
