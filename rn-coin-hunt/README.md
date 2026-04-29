# 🪙 RN Coin Hunt

Telegram Mini App with Admin Panel — Complete Coin Earning & Withdrawal System

---

## Project Structure

```
rn-coin-hunt/
├── user-app/          ← Telegram Mini App (User Interface)
│   └── index.html
├── admin-panel/       ← Admin Dashboard (Web)
│   └── index.html
├── bot/               ← Telegram Bot (Withdrawal Flow + Notifications)
│   ├── bot.js
│   ├── package.json
│   └── .env.example
├── server.js          ← Express server (serves all files on Render)
├── package.json
└── README.md
```

---

## Step-by-Step Setup

### Step 1: Create Firebase Project

1. Go to https://console.firebase.google.com
2. Create a new project (e.g., `rn-coin-hunt`)
3. Enable **Authentication** → Email/Password
4. Enable **Firestore Database** → Start in production mode
5. Add these Firestore rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }
    match /withdrawals/{id} {
      allow read, write: if request.auth != null;
    }
    match /notifications/{id} {
      allow read: if request.auth != null;
    }
    match /user_notifications/{id} {
      allow read: if request.auth != null && resource.data.userId == request.auth.uid;
    }
    match /config/main {
      allow read: if request.auth != null;
    }
  }
}
```

6. Go to Project Settings → Your apps → Add Web App → Copy the `firebaseConfig`

### Step 2: Get Firebase Admin SDK Key

1. Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key" → Download JSON file
3. Keep this safe — you'll need it for the bot

### Step 3: Update Firebase Config in Files

Replace `YOUR_FIREBASE_API_KEY`, `YOUR_PROJECT_ID` etc. in:
- `user-app/index.html` (near the bottom in the script section)
- `admin-panel/index.html` (near the bottom in the script section)

Also replace `YOUR_FIREBASE_UID_HERE` in `admin-panel/index.html` with your Firebase UID.

**How to find your Firebase UID:**
- Login to Firebase console → Authentication → Users → copy your UID

### Step 4: Configure the Bot

1. Message @BotFather on Telegram
2. Create bot or use existing one
3. Set Mini App: `/newapp` → select your bot → set URL to your Render URL + `/user-app/`
4. Enable Menu Button: `/setmenubutton` → select bot → set URL

Edit `bot/.env.example`, rename to `bot/.env`, and fill in:
```
BOT_TOKEN=8718584802:AAHswaep8g16-H6q_ezOewkQzsfEdhX6xPA
ADMIN_TELEGRAM_IDS=1414414216,7728185213
MINI_APP_URL=https://YOUR-APP.onrender.com/user-app/
SERVER_URL=https://YOUR-APP.onrender.com
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}  ← paste entire JSON as one line
```

### Step 5: Add Monetag Ad Code

1. Go to Monetag.com → Create account
2. Select "Telegram Mini App" ad format
3. Copy the SDK script tag
4. In `user-app/index.html`, find the comment:
   ```html
   <!-- Monetag Ad SDK: Replace with your Monetag Telegram Mini App ad code -->
   ```
5. Replace with your Monetag script

6. Also find `window.watchAd = async function()` and replace the TODO comment with your Monetag ad call.

### Step 6: Deploy to Render

#### Website (serves user-app + admin-panel):
1. Push code to GitHub
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Deploy → Note the URL (e.g., `https://rn-coin-hunt.onrender.com`)

#### Bot (separate service):
1. Render → New → Web Service (or Background Worker)
2. Root Directory: `bot`
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add all Environment Variables from `.env`

### Step 7: Link Telegram Bot Menu

In BotFather:
```
/setmenubutton
→ Select your bot
→ Enter URL: https://your-app.onrender.com/user-app/
→ Enter button text: 🪙 Open App
```

---

## How Everything Works

| Component | What it does |
|-----------|-------------|
| **User App** | Telegram Mini App — earn coins via ads, check-in, math quiz, referrals |
| **Admin Panel** | Web dashboard — manage users, approve/reject withdrawals, configure settings |
| **Bot** | Handles withdrawal flow — balance check, method select, QR upload, admin notification |
| **Firebase** | Shared database — real-time sync between all components |

### Withdrawal Flow
```
User taps "Balance & Withdraw" in bot menu
    → Bot shows balance + payment methods (from admin settings)
    → User selects method
    → Bot asks coin amount
    → Bot asks account holder name
    → Bot asks QR code upload
    → Bot shows summary → User confirms
    → Coins deducted, request saved to Firebase
    → Admin notified on Telegram with QR photo
    → Admin checks Admin Panel → Approve or Reject (with reason)
    → User notified in bot + notifications tab in app
```

---

## Firestore Collections

| Collection | Purpose |
|-----------|---------|
| `users` | User profiles, balances, task counts |
| `withdrawals` | Withdrawal requests with QR URLs |
| `notifications` | Broadcast notifications from admin |
| `user_notifications` | Personal notifications (approved/rejected) |
| `config/main` | App configuration (rewards, limits, payment methods) |
