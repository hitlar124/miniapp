# 🪙 RN Coin Hunt — সম্পূর্ণ সেটআপ গাইড

> কোনো কোড এডিট করতে হবে না। শুধু নিচের ধাপগুলো একে একে করুন।

---

# ধাপ ১ — Firebase প্রজেক্ট তৈরি করুন

## ১.১ — নতুন প্রজেক্ট খুলুন

1. ব্রাউজারে যান → **https://console.firebase.google.com**
2. Google account দিয়ে লগিন করুন
3. **"Create a project"** বাটনে ক্লিক করুন
4. Project name: **rn-coin-hunt** লিখুন → **Continue**
5. Google Analytics: **Enable this project for Google Analytics** — বন্ধ করুন (toggle off)
6. **"Create project"** চাপুন
7. কিছুক্ষণ অপেক্ষা করুন → **"Continue"** চাপুন

---

## ১.২ — Authentication চালু করুন

1. বামে মেনুতে **"Build"** → **"Authentication"** ক্লিক করুন
2. **"Get started"** বাটন চাপুন
3. **"Email/Password"** এ ক্লিক করুন
4. প্রথম toggle **"Enable"** করুন (নীল হবে)
5. **"Save"** চাপুন

---

## ১.৩ — Firestore Database তৈরি করুন

1. বামে মেনু → **"Build"** → **"Firestore Database"**
2. **"Create database"** বাটন চাপুন
3. **"Start in production mode"** সিলেক্ট করুন → **"Next"**
4. Location dropdown থেকে **"asia-south1 (Mumbai)"** সিলেক্ট করুন
5. **"Enable"** চাপুন — কিছুক্ষণ লোড হবে

---

## ১.৪ — Firestore Rules সেট করুন

1. Firestore Database পেজে উপরে **"Rules"** ট্যাবে ক্লিক করুন
2. বক্সের সব লেখা মুছে দিন
3. নিচের পুরো কোড কপি করে পেস্ট করুন:

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

4. **"Publish"** বাটন চাপুন

---

## ১.৫ — Firebase Web Config সংগ্রহ করুন

> এই মানগুলো পরে Render-এ এবং Admin Panel-এ লাগবে।

1. উপরে বাম কোণে **Project Overview** এর পাশে ⚙️ আইকন → **"Project settings"** ক্লিক করুন
2. পেজটা নিচে স্ক্রল করুন — **"Your apps"** সেকশন দেখবেন
3. যদি কোনো app না থাকে → **`</>`** (Web app) আইকনে ক্লিক করুন
4. App nickname লিখুন: **web** → **"Register app"** চাপুন
5. নিচে এইরকম কোড দেখাবে:

```
apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXX"
authDomain: "rn-coin-hunt.firebaseapp.com"
projectId: "rn-coin-hunt"
storageBucket: "rn-coin-hunt.appspot.com"
messagingSenderId: "123456789012"
appId: "1:123456789012:web:abcdef123456"
```

6. এই ৬টা মান **নোটপ্যাড** বা কোনো জায়গায় কপি করে রাখুন

---

## ১.৬ — Firebase Admin SDK Key নামান (Bot-এর জন্য)

1. **Project settings** পেজে উপরে **"Service accounts"** ট্যাবে ক্লিক করুন
2. **"Generate new private key"** বাটন চাপুন
3. আবার **"Generate key"** চাপুন → একটা `.json` ফাইল নামবে
4. এই ফাইলটা কম্পিউটারে সেভ করুন — পরে লাগবে

---

# ধাপ ২ — GitHub-এ কোড আপলোড করুন

## ২.১ — GitHub Account ও Repository তৈরি

1. **https://github.com** — লগিন করুন (না থাকলে তৈরি করুন)
2. উপরে ডানে **"+"** আইকন → **"New repository"**
3. Repository name: **rn-coin-hunt**
4. **"Private"** সিলেক্ট করুন
5. **"Create repository"** চাপুন

## ২.২ — কোড Push করুন

আপনার কম্পিউটারে **Terminal** (Mac/Linux) বা **Command Prompt** (Windows) খুলুন।

নিচের কমান্ডগুলো একে একে চালান:

```bash
cd rn-coin-hunt
```
```bash
git init
```
```bash
git add .
```
```bash
git commit -m "first commit"
```
```bash
git branch -M main
```
```bash
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/rn-coin-hunt.git
```
```bash
git push -u origin main
```

> ⚠️ **YOUR_GITHUB_USERNAME** জায়গায় আপনার আসল GitHub username বসান

---

# ধাপ ৩ — Render-এ Main Server Deploy করুন

> এই সার্ভিসে User App + Admin Panel দুটোই চলবে।

## ৩.১ — Render Account

1. **https://render.com** → **"Get Started"** → GitHub দিয়ে Sign Up করুন

## ৩.২ — New Web Service তৈরি

1. Render Dashboard → **"New +"** → **"Web Service"**
2. **"Build and deploy from a Git repository"** → **"Next"**
3. GitHub connect করুন → **rn-coin-hunt** repository খুঁজে **"Connect"** চাপুন
4. নিচের মতো সেটিং করুন:

| Field | যা লিখবেন |
|-------|-----------|
| Name | `rn-coin-hunt` |
| Region | Singapore (বা কাছের যেকোনো) |
| Root Directory | *(খালি রাখুন)* |
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Instance Type | Free |

## ৩.৩ — Environment Variables যুক্ত করুন

নিচে স্ক্রল করুন → **"Environment Variables"** সেকশন।
**"Add Environment Variable"** বাটন চেপে একে একে এগুলো যুক্ত করুন:

> ফর্ম্যাট: বাম বক্সে **Name**, ডান বক্সে **Value**

| Name | Value (কোথা থেকে নেবেন) |
|------|------------------------|
| `FIREBASE_API_KEY` | Firebase Config → apiKey এর ভ্যালু |
| `FIREBASE_AUTH_DOMAIN` | Firebase Config → authDomain এর ভ্যালু |
| `FIREBASE_PROJECT_ID` | Firebase Config → projectId এর ভ্যালু |
| `FIREBASE_STORAGE_BUCKET` | Firebase Config → storageBucket এর ভ্যালু |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase Config → messagingSenderId এর ভ্যালু |
| `FIREBASE_APP_ID` | Firebase Config → appId এর ভ্যালু |
| `BOT_USERNAME` | আপনার bot-এর username (@ ছাড়া, যেমন: `RNCoinHuntBot`) |

**উদাহরণ:**
```
Name:  FIREBASE_API_KEY
Value: AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXX
```

## ৩.৪ — Deploy করুন

1. **"Create Web Service"** বাটন চাপুন
2. Deploy শুরু হবে — **৩-৫ মিনিট** অপেক্ষা করুন
3. উপরে সবুজ **"Live"** লেখা দেখালে সফল হয়েছে
4. URL দেখবেন এরকম: **`https://rn-coin-hunt.onrender.com`**
5. এই URL কোথাও সেভ করুন — সব জায়গায় লাগবে

---

# ধাপ ৪ — Render-এ Bot Deploy করুন

## ৪.১ — Firebase JSON ফাইল প্রস্তুত করুন

1. ধাপ ১.৬-এ নামানো `.json` ফাইলটা **Notepad** দিয়ে খুলুন
2. সব কিছু **Ctrl+A** দিয়ে সিলেক্ট করুন → **Ctrl+C** করে কপি করুন
3. এটাই `FIREBASE_SERVICE_ACCOUNT` এর ভ্যালু হবে

## ৪.২ — Bot Web Service তৈরি

1. Render → **"New +"** → **"Web Service"**
2. একই **rn-coin-hunt** repository → **"Connect"**
3. সেটিং:

| Field | যা লিখবেন |
|-------|-----------|
| Name | `rn-coin-hunt-bot` |
| Root Directory | `bot` |
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `node bot.js` |
| Instance Type | Free |

## ৪.৩ — Bot Environment Variables

| Name | Value |
|------|-------|
| `BOT_TOKEN` | `8718584802:AAHswaep8g16-H6q_ezOewkQzsfEdhX6xPA` |
| `ADMIN_TELEGRAM_IDS` | `1414414216,7728185213` |
| `MINI_APP_URL` | `https://rn-coin-hunt.onrender.com/user-app/` *(আপনার আসল URL দিন)* |
| `SERVER_URL` | `https://rn-coin-hunt.onrender.com` *(আপনার আসল URL দিন)* |
| `BOT_USERNAME` | আপনার bot username (@ ছাড়া) |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase JSON ফাইলের পুরো কন্টেন্ট |

4. **"Create Web Service"** চাপুন → Deploy হতে দিন

---

# ধাপ ৫ — Admin Panel First Time Setup করুন

## ৫.১ — Admin Panel খুলুন

ব্রাউজারে যান:
```
https://rn-coin-hunt.onrender.com/admin-panel/
```
*(rn-coin-hunt জায়গায় আপনার আসল Render URL বসান)*

## ৫.২ — Step 1: Panel Login তৈরি করুন

1. **Panel Username** বক্সে একটা username লিখুন (যেমন: `admin`)
2. **Panel Password** বক্সে একটা পাসওয়ার্ড লিখুন (কমপক্ষে ৬ অক্ষর)
3. **Confirm Password** বক্সে একই পাসওয়ার্ড আবার লিখুন
4. **"Next →"** চাপুন

## ৫.৩ — Step 2: Firebase Config দিন

ধাপ ১.৫-এ নোটপ্যাডে সেভ করা মানগুলো এখানে বক্সে বসান:

| বক্সের নাম | কোথা থেকে কপি করবেন |
|-----------|---------------------|
| API Key | `apiKey:` এর পরের মান (quotes ছাড়া) |
| Auth Domain | `authDomain:` এর পরের মান |
| Project ID | `projectId:` এর পরের মান |
| Storage Bucket | `storageBucket:` এর পরের মান |
| Messaging Sender ID | `messagingSenderId:` এর পরের মান |
| App ID | `appId:` এর পরের মান |

5. **"Next →"** চাপুন

## ৫.৪ — Step 3: Admin UID দিন

**Admin UID কীভাবে পাবেন:**

1. নতুন ট্যাবে যান → User App খুলুন:
   ```
   https://rn-coin-hunt.onrender.com/user-app/
   ```
2. **"Create Account"** দিয়ে আপনার email ও password দিয়ে register করুন
3. এবার **Firebase Console** খুলুন → **Authentication** → **Users** ট্যাব
4. আপনার email এর পাশে **User UID** কলামে একটা লম্বা কোড দেখবেন
5. সেই কোডটা **কপি** করুন

**Admin Panel-এ ফিরে আসুন:**
1. **Admin UID(s)** বক্সে সেই কোড পেস্ট করুন
2. **"Finish Setup ✓"** চাপুন
3. এখন username ও password দিয়ে **লগিন** করুন

---

## ৫.৫ — App Settings কনফিগার করুন

1. Admin Panel-এ লগিন করার পর বামে **"Settings"** ক্লিক করুন
2. **"App Settings"** ট্যাবে ক্লিক করুন
3. নিচের মানগুলো সেট করুন (পরে যেকোনো সময় পরিবর্তন করা যাবে):

| Setting | সুপারিশকৃত মান | মানে |
|---------|----------------|------|
| Daily Ad Limit | `10` | প্রতিদিন সর্বোচ্চ কতটা Ad দেখা যাবে |
| Ad Cooldown | `30` | প্রতিটা Ad-এর মাঝে কত সেকেন্ড বিরতি |
| Daily Math Limit | `10` | প্রতিদিন কতটা Math Quiz |
| Math Cooldown | `30` | Math Quiz-এর মাঝে বিরতি |
| Check-in Coins | `50` | প্রতিদিন Check-in করলে কত Coin |
| Referral Bonus | `100` | কেউ Refer করলে কত Coin |
| Ad Reward | `50` | একটা Ad দেখলে কত Coin |
| Math Quiz Reward | `10` | একটা Quiz করলে কত Coin |
| Min Withdrawal | `5000` | কমপক্ষে কত Coin হলে Withdraw করা যাবে |
| Exchange: Coins | `1000` | ১০০০ Coin = |
| Exchange: ₹ | `10` | ১০ টাকা |
| Payment Methods | `UPI, Paytm, bKash` | আপনার দেশ অনুযায়ী লিখুন |

4. **"Save App Settings"** চাপুন

---

# ধাপ ৬ — Telegram Bot সেটআপ করুন

## ৬.১ — Menu Button সেট করুন

Telegram-এ **@BotFather** খুলুন → এই কমান্ড পাঠান:

```
/setmenubutton
```

BotFather জিজ্ঞেস করবে কোন bot → আপনার bot সিলেক্ট করুন।
তারপর URL চাইবে → পাঠান:
```
https://rn-coin-hunt.onrender.com/user-app/
```
*(আপনার আসল URL দিন)*

Button text চাইলে পাঠান:
```
🪙 Open App
```

## ৬.২ — Bot Start করে Test করুন

1. Telegram-এ আপনার bot খুলুন
2. **"/start"** পাঠান
3. নিচে **"🪙 Open App"** বাটন দেখা উচিত
4. বাটনে চাপলে User App খুলবে

---

# ধাপ ৭ — সব কিছু কাজ করছে কিনা চেক করুন

| কী চেক করবেন | কীভাবে |
|-------------|--------|
| User App | `https://your-app.onrender.com/user-app/` খুলুন → Register করুন |
| Admin Panel | `https://your-app.onrender.com/admin-panel/` → লগিন করুন |
| Bot | Telegram-এ bot-এ `/start` পাঠান |
| Withdrawal test | Bot-এ Balance চাপুন → Withdrawal করুন → Admin Panel-এ আসে কিনা দেখুন |
| Approve test | Admin Panel থেকে Approve করুন → User App-এর Notifications-এ আসে কিনা দেখুন |

---

# সমস্যা হলে

**"Firebase not configured" দেখাচ্ছে User App-এ:**
→ Render-এ Main Server সার্ভিসে গিয়ে Environment Variables চেক করুন। সব ৬টা Firebase variable ঠিকমতো আছে কিনা দেখুন।

**Admin Panel Setup-এর পর লগিন হচ্ছে না:**
→ Browser-এ Ctrl+Shift+Delete → Cookies and Site Data clear করুন → আবার Setup করুন।

**Bot কাজ করছে না:**
→ Render-এ Bot সার্ভিস → "Logs" ট্যাব দেখুন। `FIREBASE_SERVICE_ACCOUNT` JSON সঠিকভাবে পেস্ট হয়েছে কিনা চেক করুন।

**Withdrawal Approve করলে User-কে Notify হচ্ছে না:**
→ Firestore Rules আবার চেক করুন (ধাপ ১.৪)।
