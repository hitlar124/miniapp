# 🪙 RN Coin Hunt — সম্পূর্ণ সেটআপ গাইড (বিগিনারদের জন্য)

> ✅ কোনো কোড এডিট করতে হবে না — সব কিছু Admin Panel বা Render থেকে করা যাবে।

---

## প্রথমে বুঝুন — কোথায় কী করতে হবে

| কাজ | কোথায় |
|-----|--------|
| Firebase তৈরি | firebase.google.com |
| GitHub-এ কোড আপলোড | github.com |
| ওয়েবসাইট হোস্টিং (Main App + Bot) | render.com |
| Firebase config, Admin UID যুক্ত করা | **Admin Panel → Settings** |
| Bot Token, Firebase keys (server/bot) | **Render → Environment Variables** |
| Telegram Bot তৈরি | Telegram-এ @BotFather |

---

## ধাপ ১ — Firebase প্রজেক্ট তৈরি করুন

### ১.১ — নতুন প্রজেক্ট
1. **https://console.firebase.google.com** — এই লিঙ্কে যান
2. Google account দিয়ে লগিন করুন
3. **"Add project"** বাটনে ক্লিক করুন
4. নাম দিন: `rn-coin-hunt`
5. Google Analytics: **Disable** করুন
6. **"Create project"** চাপুন

### ১.২ — Authentication চালু করুন
1. বামে মেনু থেকে **"Build"** → **"Authentication"** ক্লিক করুন
2. **"Get started"** বাটন চাপুন
3. **"Email/Password"** তে ক্লিক করুন
4. **Enable** করুন → **Save**

### ১.৩ — Firestore Database তৈরি করুন
1. বামে মেনু → **"Build"** → **"Firestore Database"**
2. **"Create database"** চাপুন
3. **"Start in production mode"** সিলেক্ট করুন → **Next**
4. Location: **asia-south1** (বা আপনার কাছের যেকোনো) → **Enable**

### ১.৪ — Firestore Rules সেট করুন
1. Firestore Database-এ গিয়ে **"Rules"** ট্যাবে ক্লিক করুন
2. সব কিছু মুছে নিচের কোড পেস্ট করুন:

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
      allow read: if request.auth != null;
    }
    match /config/main {
      allow read: if request.auth != null;
      allow write: if false;
    }
  }
}
```

3. **"Publish"** চাপুন

### ১.৫ — Firebase Web Config সংগ্রহ করুন
1. Firebase Console-এ উপরে **Project Overview** পাতা → ⚙️ (Settings icon) → **"Project settings"**
2. নিচে স্ক্রল করুন — **"Your apps"** সেকশন দেখবেন
3. যদি কোনো App না থাকে → **`</>`** (Web) আইকনে ক্লিক করুন
4. App nickname দিন: `rn-coin-hunt-web` → **Register app**
5. নিচে এইরকম একটা কোড দেখবেন:
```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "rn-coin-hunt.firebaseapp.com",
  projectId: "rn-coin-hunt",
  storageBucket: "rn-coin-hunt.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```
6. **এই ৬টি মান কোথাও সেভ করুন** (নোটপ্যাডে) — পরে Admin Panel-এ লাগবে

### ১.৬ — Firebase Admin SDK Key নামান
1. **Project Settings** → **"Service accounts"** ট্যাব
2. **"Generate new private key"** বাটন চাপুন
3. একটা `.json` ফাইল নামবে — এটা সেভ করুন
4. এই ফাইলটা **Bot-এর জন্য লাগবে** (Render-এ পেস্ট করতে হবে)

---

## ধাপ ২ — GitHub-এ কোড আপলোড করুন

> আপনার কম্পিউটারে এই প্রজেক্টের `rn-coin-hunt/` ফোল্ডার আছে।

### ২.১ — GitHub Account
1. **https://github.com** — লগিন করুন (না থাকলে তৈরি করুন)
2. উপরে **"+"** → **"New repository"**
3. Repository name: `rn-coin-hunt`
4. **Private** রাখুন
5. **"Create repository"** চাপুন

### ২.২ — Shell থেকে কোড Push করুন

আপনার কম্পিউটারে Terminal/Command Prompt খুলুন এবং এই কমান্ডগুলো একে একে চালান:

```bash
cd rn-coin-hunt
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/rn-coin-hunt.git
git push -u origin main
```

> ⚠️ `YOUR_USERNAME` জায়গায় আপনার GitHub username বসান

---

## ধাপ ৩ — Render-এ Main Server Deploy করুন

> Main Server = User App + Admin Panel একসাথে চলবে

### ৩.১ — Render Account
1. **https://render.com** — Google বা GitHub দিয়ে Sign Up করুন

### ৩.২ — New Web Service তৈরি
1. Dashboard-এ **"New +"** → **"Web Service"**
2. **"Connect a repository"** → GitHub সংযুক্ত করুন
3. আপনার `rn-coin-hunt` repository সিলেক্ট করুন → **Connect**
4. নিচের মতো সেটিং করুন:

| Field | Value |
|-------|-------|
| Name | `rn-coin-hunt` |
| Root Directory | (খালি রাখুন) |
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `node server.js` |

### ৩.৩ — Environment Variables যুক্ত করুন
**"Environment"** সেকশনে গিয়ে **"Add Environment Variable"** দিয়ে এই ভ্যারিয়েবলগুলো যুক্ত করুন:

| Variable Name | Value (কোথায় পাবেন) |
|---------------|---------------------|
| `FIREBASE_API_KEY` | Firebase Config → apiKey |
| `FIREBASE_AUTH_DOMAIN` | Firebase Config → authDomain |
| `FIREBASE_PROJECT_ID` | Firebase Config → projectId |
| `FIREBASE_STORAGE_BUCKET` | Firebase Config → storageBucket |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase Config → messagingSenderId |
| `FIREBASE_APP_ID` | Firebase Config → appId |
| `BOT_USERNAME` | আপনার bot-এর username (@ ছাড়া) |

### ৩.৪ — Deploy করুন
1. **"Create Web Service"** চাপুন
2. Deploy শুরু হবে — ৩-৫ মিনিট অপেক্ষা করুন
3. উপরে একটা URL দেখবেন: `https://rn-coin-hunt.onrender.com`
4. **এই URL সেভ করুন** — পরে লাগবে

---

## ধাপ ৪ — Render-এ Bot Deploy করুন

### ৪.১ — Firebase Service Account JSON প্রস্তুত করুন
1. ধাপ ১.৬-এ নামানো `.json` ফাইলটা খুলুন (Notepad/TextEdit দিয়ে)
2. সব কিছু **একটা লাইনে** কপি করুন (সেটা এমনিতেই এক লাইনে থাকবে)
3. এটা `FIREBASE_SERVICE_ACCOUNT` হিসেবে Render-এ দেবেন

### ৪.২ — Bot সার্ভিস তৈরি
1. Render → **"New +"** → **"Web Service"** (বা Background Worker)
2. একই `rn-coin-hunt` repository সিলেক্ট করুন
3. সেটিং:

| Field | Value |
|-------|-------|
| Name | `rn-coin-hunt-bot` |
| Root Directory | `bot` |
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `node bot.js` |

### ৪.৩ — Bot Environment Variables
| Variable Name | Value |
|---------------|-------|
| `BOT_TOKEN` | `8718584802:AAHswaep8g16-H6q_ezOewkQzsfEdhX6xPA` |
| `ADMIN_TELEGRAM_IDS` | `1414414216,7728185213` |
| `MINI_APP_URL` | `https://rn-coin-hunt.onrender.com/user-app/` |
| `SERVER_URL` | `https://rn-coin-hunt.onrender.com` |
| `BOT_USERNAME` | আপনার bot username |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase JSON (পুরো এক লাইন) |

4. **"Create Web Service"** চাপুন

---

## ধাপ ৫ — Admin Panel সেটআপ করুন

### ৫.১ — Admin Panel খুলুন
1. ব্রাউজারে যান: `https://rn-coin-hunt.onrender.com/admin-panel/`
2. প্রথমবার খুললে **"First Time Setup"** পেজ দেখাবে

### ৫.২ — Step 1: Panel Login সেট করুন
1. **Panel Username** দিন (যেকোনো নাম, যেমন: `admin`)
2. **Panel Password** দিন (শক্তিশালী পাসওয়ার্ড)
3. Password confirm করুন
4. **"Next →"** চাপুন

### ৫.৩ — Step 2: Firebase Config দিন
1. ধাপ ১.৫-এ সেভ করা Firebase Config-এর মানগুলো বক্সগুলোতে বসান:
   - **API Key** → apiKey মানটা
   - **Auth Domain** → authDomain মানটা
   - **Project ID** → projectId মানটা
   - **Storage Bucket** → storageBucket মানটা
   - **Messaging Sender ID** → messagingSenderId মানটা
   - **App ID** → appId মানটা
2. **"Next →"** চাপুন

### ৫.৪ — Step 3: Admin UID দিন
> **Admin UID কোথায় পাবেন?**
> 1. প্রথমে User App খুলুন: `https://rn-coin-hunt.onrender.com/user-app/`
> 2. আপনার email দিয়ে **Register** করুন
> 3. Firebase Console → **Authentication** → **Users** ট্যাব
> 4. আপনার email খুঁজুন → পাশে **UID** কলামে যে লম্বা কোড আছে সেটা কপি করুন

1. সেই UID বক্সে পেস্ট করুন
2. **"Finish Setup ✓"** চাপুন
3. এখন **Login** করুন username ও password দিয়ে

### ৫.৫ — App Settings কনফিগার করুন
1. Admin Panel-এ লগিন করুন
2. বামে **"Settings"** ক্লিক করুন
3. **"App Settings"** ট্যাবে যান
4. Reward, Limit, Payment Methods — সব নিজের মতো সেট করুন
5. **"Save App Settings"** চাপুন

---

## ধাপ ৬ — Telegram Bot সেটআপ করুন

### ৬.১ — Bot Menu Button সেট করুন
Telegram-এ @BotFather খুলুন:
```
/setmenubutton
→ আপনার bot সিলেক্ট করুন
→ URL দিন: https://rn-coin-hunt.onrender.com/user-app/
→ Button text দিন: 🪙 Open App
```

### ৬.২ — Mini App তৈরি করুন
```
/newapp
→ আপনার bot সিলেক্ট করুন
→ App title: RN Coin Hunt
→ Description: Earn coins and withdraw
→ URL: https://rn-coin-hunt.onrender.com/user-app/
```

---

## ধাপ ৭ — Monetag Ad যুক্ত করুন (ঐচ্ছিক)

1. **https://monetag.com** → Account তৈরি করুন
2. **Telegram Mini App** ad format সিলেক্ট করুন
3. Zone তৈরি করুন → SDK Script কপি করুন
4. User App-এর `index.html` খুলুন (শুধু এই একটাবার কোড এডিট করতে হবে)
5. এই মন্তব্যের জায়গায় script বসান:
   ```html
   <!-- Monetag Ad SDK: Replace with your Monetag Telegram Mini App ad code -->
   ```

---

## সব কিছু ঠিকঠাক হয়েছে কিনা চেক করুন

| চেক | কীভাবে |
|-----|--------|
| User App কাজ করছে | `https://your-app.onrender.com/user-app/` খুলুন |
| Admin Panel কাজ করছে | `https://your-app.onrender.com/admin-panel/` খুলুন |
| Bot চালু আছে | Telegram-এ bot-এ মেসেজ পাঠান `/start` |
| Withdrawal notification | Bot থেকে একটা test withdrawal করুন → Admin Telegram-এ নোটিফিকেশন আসা উচিত |

---

## সমস্যা হলে কী করবেন

**User App খুললে "Firebase not configured" দেখাচ্ছে:**
→ Render-এ Firebase environment variables ঠিকমতো দেওয়া হয়নি। আবার চেক করুন।

**Admin Panel-এ লগিন হচ্ছে না:**
→ Setup-এর সময় দেওয়া username/password মনে নেই? Browser-এর localStorage clear করুন → আবার setup করুন।

**Bot কাজ করছে না:**
→ Render Bot সার্ভিসের Logs চেক করুন। `FIREBASE_SERVICE_ACCOUNT` JSON ঠিকমতো পেস্ট হয়েছে কিনা দেখুন।

**Withdrawal approve করলে user notify হচ্ছে না:**
→ Firestore Rules সঠিকভাবে সেট হয়েছে কিনা চেক করুন (ধাপ ১.৪)।
