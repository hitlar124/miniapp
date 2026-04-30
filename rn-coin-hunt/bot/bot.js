const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const express = require('express');
const path = require('path');
const fs = require('fs');

// ── Config from environment variables ──────────────────────────
const BOT_TOKEN          = process.env.BOT_TOKEN || '';
const ADMIN_IDS          = (process.env.ADMIN_TELEGRAM_IDS || '1414414216,7728185213').split(',').map(s => s.trim());
const MINI_APP_URL       = process.env.MINI_APP_URL  || 'https://your-app.onrender.com/user-app/';
const SERVER_URL         = process.env.SERVER_URL    || 'https://your-app.onrender.com';
const PORT               = process.env.PORT          || 3001;

// ── Firebase Admin ──────────────────────────────────────────────
try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    initializeApp({ credential: cert(svc) });
} catch (e) {
    console.error('Firebase init error:', e.message);
}
const db = getFirestore();

// ── Bot ─────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// QR upload directory
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Per-user withdrawal flow state: { step, data }
const wState = {};

// ── Main menu keyboard ───────────────────────────────────────────
const mainMenu = (url) => ({
    reply_markup: {
        keyboard: [
            [{ text: '🪙 Open App', web_app: { url } }],
            [{ text: '💰 Balance & Withdraw' }],
            [{ text: '📊 My Stats' }, { text: '🆘 Help' }]
        ],
        resize_keyboard: true,
        persistent: true
    }
});

// ── /start ───────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const param  = (match[1] || '').trim().replace(/^\//, '');
    const appUrl = param ? `${MINI_APP_URL}?start=${param}` : MINI_APP_URL;

    // Try to save Telegram ID to user's Firebase doc
    try {
        const snap = await db.collection('users').where('telegramId', '==', userId).limit(1).get();
        if (snap.empty) {
            // User hasn't opened the app yet — that's fine
        }
    } catch (e) { /* ignore */ }

    bot.sendMessage(chatId,
        `👋 *Welcome to RN Coin Hunt!*\n\n` +
        `🪙 Complete tasks & earn coins\n` +
        `💰 Withdraw your earnings anytime\n\n` +
        `Tap *🪙 Open App* to start earning!`,
        { parse_mode: 'Markdown', ...mainMenu(appUrl) }
    );
});

// ── Single message handler ───────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text   = msg.text || '';
    const photo  = msg.photo;

    // Ignore /start (handled above)
    if (text.startsWith('/start')) return;

    // ── Withdrawal flow in progress ──
    if (wState[userId]) {
        await handleFlow(msg);
        return;
    }

    // ── Menu buttons ──
    if (text === '💰 Balance & Withdraw') {
        await showBalance(chatId, userId);

    } else if (text.startsWith('💳 Withdraw via ')) {
        const method = text.replace('💳 Withdraw via ', '').trim();
        wState[userId] = { step: 'ask_amount', data: { method } };
        bot.sendMessage(chatId,
            `✅ Method: *${method}*\n\nকতটা Coin Withdraw করতে চান? (শুধু সংখ্যা লিখুন)`,
            { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '❌ Cancel' }]], resize_keyboard: true } }
        );

    } else if (text === '🔙 Back to Menu') {
        sendMain(chatId);

    } else if (text === '📊 My Stats') {
        await showStats(chatId, userId);

    } else if (text === '🆘 Help') {
        showHelp(chatId);
    }
});

// ── Withdrawal flow handler ──────────────────────────────────────
async function handleFlow(msg) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text   = msg.text || '';
    const photo  = msg.photo;
    const state  = wState[userId];
    if (!state) return;

    // Cancel
    if (text === '❌ Cancel') {
        delete wState[userId];
        bot.sendMessage(chatId, '❌ Withdrawal cancelled.', { reply_markup: { remove_keyboard: true } });
        setTimeout(() => sendMain(chatId), 600);
        return;
    }

    // Step 1: Amount
    if (state.step === 'ask_amount') {
        const amount = parseInt(text);
        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(chatId, '❌ শুধু সংখ্যা লিখুন। যেমন: 5000');
            return;
        }
        try {
            const user = await getUserByTgId(userId);
            if (!user) { bot.sendMessage(chatId, '⚠️ Account পাওয়া যায়নি। আগে App খুলুন ও login করুন।'); delete wState[userId]; return; }
            const cfg = await getConfig();
            if (amount < cfg.minWithdrawal) {
                bot.sendMessage(chatId, `❌ সর্বনিম্ন Withdrawal: *${cfg.minWithdrawal}* Coins`, { parse_mode: 'Markdown' });
                return;
            }
            if (amount > (user.balance || 0)) {
                bot.sendMessage(chatId, `❌ আপনার Balance: *${user.balance || 0}* Coins — এত Coin নেই।`, { parse_mode: 'Markdown' });
                return;
            }
            state.data.amount = amount;
            state.data.userId = user.id;
            state.data.userName = user.name;
            state.data.userEmail = user.email;
            state.step = 'ask_account_name';
            bot.sendMessage(chatId,
                `✅ Amount: *${amount} Coins*\n\nআপনার *Account Holder Name* লিখুন:`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) { console.error(e); bot.sendMessage(chatId, 'Error. Try again.'); }
        return;
    }

    // Step 2: Account name
    if (state.step === 'ask_account_name') {
        if (text.length < 2) { bot.sendMessage(chatId, '❌ নাম সঠিকভাবে লিখুন।'); return; }
        state.data.accountName = text.trim();
        state.step = 'ask_qr';
        bot.sendMessage(chatId,
            `✅ Name: *${state.data.accountName}*\n\nএখন আপনার *Payment QR Code* ছবি পাঠান:`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Step 3: QR photo
    if (state.step === 'ask_qr') {
        if (!photo) {
            bot.sendMessage(chatId, '📸 একটা QR Code ছবি পাঠান (ফটো হিসেবে)।');
            return;
        }
        try {
            const fileId  = photo[photo.length - 1].file_id;
            const fileUrl = await bot.getFileLink(fileId);
            const fname   = `qr_${userId}_${Date.now()}.jpg`;
            const fpath   = path.join(UPLOAD_DIR, fname);
            await downloadFile(fileUrl, fpath);

            state.data.qrCodeUrl   = `${SERVER_URL}/uploads/${fname}`;
            state.data.qrLocalPath = fpath;
            state.step = 'confirm';

            bot.sendMessage(chatId,
                `📋 *Withdrawal Summary*\n\n` +
                `💳 Method: *${state.data.method}*\n` +
                `🪙 Amount: *${state.data.amount} Coins*\n` +
                `👤 Name: *${state.data.accountName}*\n` +
                `📷 QR Code: ✅ Uploaded\n\n` +
                `Submit করবেন?`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [[{ text: '✅ Confirm & Submit' }, { text: '❌ Cancel' }]],
                        resize_keyboard: true
                    }
                }
            );
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, 'QR upload error. আবার চেষ্টা করুন।');
        }
        return;
    }

    // Step 4: Confirm
    if (state.step === 'confirm') {
        if (text !== '✅ Confirm & Submit') {
            bot.sendMessage(chatId, '✅ Confirm করুন অথবা ❌ Cancel করুন।');
            return;
        }
        try {
            // Double-check balance
            const user = await getUserByTgId(userId);
            if (!user || (user.balance || 0) < state.data.amount) {
                bot.sendMessage(chatId, '❌ Balance অপর্যাপ্ত।');
                delete wState[userId];
                return;
            }

            // Deduct coins
            await db.collection('users').doc(state.data.userId).update({
                balance: FieldValue.increment(-state.data.amount)
            });

            // Save withdrawal request
            const wRef = await db.collection('withdrawals').add({
                userId:      state.data.userId,
                userName:    state.data.userName,
                userEmail:   state.data.userEmail,
                telegramId:  userId,
                amount:      state.data.amount,
                method:      state.data.method,
                accountName: state.data.accountName,
                qrCodeUrl:   state.data.qrCodeUrl,
                status:      'pending',
                requestedAt: FieldValue.serverTimestamp()
            });

            // Notify admins
            const adminMsg =
                `🔔 *New Withdrawal Request!*\n\n` +
                `👤 User: ${state.data.userName}\n` +
                `📧 Email: ${state.data.userEmail}\n` +
                `💳 Method: ${state.data.method}\n` +
                `🪙 Amount: ${state.data.amount} Coins\n` +
                `👤 Account: ${state.data.accountName}\n` +
                `🆔 Request ID: ${wRef.id}\n\n` +
                `Admin Panel-এ গিয়ে Approve বা Reject করুন।`;

            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.sendPhoto(adminId, state.data.qrLocalPath, {
                        caption: adminMsg, parse_mode: 'Markdown'
                    });
                } catch (e2) {
                    // If photo fails, send text
                    try { await bot.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' }); } catch (_) {}
                }
            }

            delete wState[userId];
            bot.sendMessage(chatId,
                `✅ *Request Submitted!*\n\n` +
                `আপনার *${state.data.amount} Coins* Withdrawal Request জমা হয়েছে।\n\n` +
                `24-48 ঘণ্টার মধ্যে Process হবে। Notification পাবেন App-এ।`,
                { parse_mode: 'Markdown', ...mainMenu(MINI_APP_URL) }
            );

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, '❌ Error submitting request. আবার চেষ্টা করুন।');
        }
        return;
    }
}

// ── Balance page ─────────────────────────────────────────────────
async function showBalance(chatId, userId) {
    try {
        const user = await getUserByTgId(userId);
        if (!user) {
            bot.sendMessage(chatId,
                `⚠️ *Account linked নেই!*\n\n` +
                `App খুলুন → Login করুন → তারপর এখানে আসুন।`,
                { parse_mode: 'Markdown', reply_markup: {
                    keyboard: [[{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }], [{ text: '🔙 Back to Menu' }]],
                    resize_keyboard: true
                }}
            );
            return;
        }

        const cfg     = await getConfig();
        const bal     = user.balance || 0;
        const inrVal  = cfg.coinValueCoins > 0 ? Math.floor(bal / cfg.coinValueCoins) * cfg.coinValueInr : 0;
        const canWd   = bal >= cfg.minWithdrawal;

        let methodBtns = [];
        if (canWd && cfg.paymentMethods.length > 0) {
            methodBtns = cfg.paymentMethods.map(m => [{ text: `💳 Withdraw via ${m}` }]);
        }

        bot.sendMessage(chatId,
            `💰 *Your Wallet*\n\n` +
            `🪙 Balance: *${bal} Coins*\n` +
            `💵 Value: *₹${inrVal}*\n` +
            `📊 Rate: ${cfg.coinValueCoins} Coins = ₹${cfg.coinValueInr}\n\n` +
            (canWd
                ? `✅ Withdraw করতে পারবেন! নিচের method বেছে নিন:`
                : `❌ Minimum withdrawal: *${cfg.minWithdrawal}* Coins\nআর *${cfg.minWithdrawal - bal}* Coins দরকার।`),
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [...methodBtns, [{ text: '🔙 Back to Menu' }]],
                    resize_keyboard: true
                }
            }
        );
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, 'Error. আবার চেষ্টা করুন।');
    }
}

// ── Stats ────────────────────────────────────────────────────────
async function showStats(chatId, userId) {
    try {
        const user = await getUserByTgId(userId);
        if (!user) { bot.sendMessage(chatId, '⚠️ App খুলুন ও Login করুন।'); return; }
        const snap  = await db.collection('withdrawals').where('userId', '==', user.id).get();
        const total = snap.docs.reduce((s, d) => s + (d.data().status === 'approved' ? d.data().amount : 0), 0);
        const pend  = snap.docs.filter(d => d.data().status === 'pending').length;
        bot.sendMessage(chatId,
            `📊 *Your Stats*\n\n` +
            `👤 Name: ${user.name}\n` +
            `📧 Email: ${user.email}\n` +
            `🪙 Balance: *${user.balance || 0}* Coins\n` +
            `✅ Total Approved: *${total}* Coins\n` +
            `⏳ Pending Requests: *${pend}*\n` +
            `📋 Total Requests: *${snap.size}*`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) { bot.sendMessage(chatId, 'Error loading stats.'); }
}

// ── Help ─────────────────────────────────────────────────────────
function showHelp(chatId) {
    bot.sendMessage(chatId,
        `🆘 *Help — RN Coin Hunt*\n\n` +
        `*🪙 Coin Earn করুন:*\n` +
        `• প্রতিদিন Check-in করুন\n` +
        `• Video Ads দেখুন\n` +
        `• Math Quiz সমাধান করুন\n` +
        `• বন্ধুদের Refer করুন\n\n` +
        `*💰 Withdraw করুন:*\n` +
        `"Balance & Withdraw" বাটন চাপুন →\n` +
        `Payment method বেছে নিন → পরিমাণ দিন →\n` +
        `Account নাম দিন → QR Code পাঠান → Confirm করুন\n\n` +
        `*📱 App:*\n` +
        `"Open App" চাপলে Full App খুলবে`,
        { parse_mode: 'Markdown' }
    );
}

// ── Send main menu ────────────────────────────────────────────────
function sendMain(chatId) {
    bot.sendMessage(chatId, '🏠 Main Menu', mainMenu(MINI_APP_URL));
}

// ── Helpers ──────────────────────────────────────────────────────
async function getUserByTgId(telegramId) {
    const snap = await db.collection('users').where('telegramId', '==', telegramId).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    return null;
}

async function getConfig() {
    try {
        const snap = await db.collection('config').doc('main').get();
        const d = snap.exists ? snap.data() : {};
        return {
            minWithdrawal:   d.minWithdrawal   || 5000,
            coinValueCoins:  d.coinValueCoins  || 1000,
            coinValueInr:    d.coinValueInr    || 10,
            paymentMethods:  d.paymentMethods  || []
        };
    } catch { return { minWithdrawal: 5000, coinValueCoins: 1000, coinValueInr: 10, paymentMethods: [] }; }
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? require('https') : require('http');
        const file  = fs.createWriteStream(dest);
        proto.get(url, res => {
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    });
}

// ── Express server (serves QR uploads) ───────────────────────────
const app = express();
app.use('/uploads', express.static(UPLOAD_DIR));
app.get('/', (_, res) => res.send('🤖 RN Coin Hunt Bot is running!'));
app.listen(PORT, () => console.log(`Bot server on port ${PORT}`));

console.log('🤖 RN Coin Hunt Bot started!');
