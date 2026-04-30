// ─────────────────────────────────────────────────────────────────
// RN Coin Hunt — Telegram Bot
// ─────────────────────────────────────────────────────────────────
const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue }  = require('firebase-admin/firestore');
const express = require('express');
const path    = require('path');
const fs      = require('fs');

// ── Config ────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN  || '';
const ADMIN_IDS   = (process.env.ADMIN_TELEGRAM_IDS || '1414414216,7728185213')
                        .split(',').map(s => s.trim());
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-app.onrender.com/user-app/';
const SERVER_URL   = process.env.SERVER_URL   || 'https://your-app.onrender.com';
const PORT         = process.env.PORT         || 3001;

// ── Firebase Admin ────────────────────────────────────────────────
try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    initializeApp({ credential: cert(svc) });
} catch (e) { console.error('Firebase init error:', e.message); }
const db = getFirestore();

// ── Bot ───────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// QR uploads directory
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── In-memory state ───────────────────────────────────────────────
const wState       = {};  // userId  → { step, data }   (user withdrawal flow)
const adminState   = {};  // adminId → { step, reqId, userId, amount }
const adminSkipped = {};  // adminId → [reqId, ...]      (for skip navigation)

// ── Keyboards ─────────────────────────────────────────────────────
const MAIN_MENU = {
    reply_markup: {
        keyboard: [
            [{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }],
            [{ text: '💰 My Balance' }, { text: '📤 Withdraw' }],
            [{ text: '📊 My Stats'  }, { text: '🆘 Help'     }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

const CANCEL_KB = {
    reply_markup: {
        keyboard: [[{ text: '❌ Cancel' }]],
        resize_keyboard: true
    }
};

// ─────────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param  = (match[1] || '').trim().replace(/^\//, '');
    const appUrl = param ? `${MINI_APP_URL}?start=${param}` : MINI_APP_URL;

    const menu = { reply_markup: { ...MAIN_MENU.reply_markup } };
    menu.reply_markup.keyboard[0][0].web_app.url = appUrl;

    bot.sendMessage(chatId,
        `👋 *RN Coin Hunt-এ স্বাগতম!*\n\n` +
        `🪙 Task করুন → Coin আয় করুন → Withdraw করুন\n\n` +
        `নিচের মেনু থেকে যেকোনো অপশন বেছে নিন 👇`,
        { parse_mode: 'Markdown', ...menu }
    );
});

// ─────────────────────────────────────────────────────────────────
// Single message handler
// ─────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text   = msg.text  || '';
    const photo  = msg.photo;

    if (text.startsWith('/start')) return; // handled above

    // ── Admin: waiting for reject reason ──────────────────────────
    if (adminState[userId]?.step === 'await_reject_reason') {
        if (text === '❌ Cancel') {
            delete adminState[userId];
            bot.sendMessage(chatId, 'বাতিল করা হয়েছে।', { reply_markup: { remove_keyboard: true } });
        } else {
            await doReject(chatId, userId, text);
        }
        return;
    }

    // ── User: in withdrawal flow ───────────────────────────────────
    if (wState[userId]) {
        await handleWithdrawFlow(msg);
        return;
    }

    // ── /admin command ─────────────────────────────────────────────
    if (text === '/admin') {
        if (!ADMIN_IDS.includes(userId)) {
            bot.sendMessage(chatId, '⛔ আপনি admin নন।');
            return;
        }
        adminSkipped[userId] = [];
        await showNextRequest(chatId, userId);
        return;
    }

    // ── Main menu buttons ──────────────────────────────────────────
    if (text === '💰 My Balance')   { await showBalance(chatId, userId);    return; }
    if (text === '📤 Withdraw')     { await startWithdraw(chatId, userId);  return; }
    if (text === '📊 My Stats')     { await showStats(chatId, userId);      return; }
    if (text === '🆘 Help')         { showHelp(chatId);                     return; }
    if (text === '🔙 Back to Menu') { bot.sendMessage(chatId, '🏠 Main Menu', MAIN_MENU); return; }
});

// ─────────────────────────────────────────────────────────────────
// Inline button callback handler  (single handler — all cases)
// ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    const msgId  = query.message.message_id;
    const data   = query.data || '';

    bot.answerCallbackQuery(query.id);

    // ── User: payment method selection ──
    if (data.startsWith('wd|method|')) {
        const method = data.replace('wd|method|', '');
        const state  = wState[userId];
        if (!state) return;
        state.data.method = method;
        state.step = 'ask_qr';
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        bot.sendMessage(chatId,
            `✅ Method: *${method}*\n\n📸 এখন আপনার *QR Code* ছবি পাঠান:`,
            { parse_mode: 'Markdown', ...CANCEL_KB }
        );
        return;
    }

    // ── User: withdrawal amount selection ──
    if (data.startsWith('wd|')) {
        const amount = parseInt(data.split('|')[1]);
        if (!isNaN(amount)) {
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
            await confirmAmountSelected(chatId, userId, amount);
        }
        return;
    }

    // ── Admin actions ──
    if (!ADMIN_IDS.includes(userId)) return;

    const parts  = data.split('|');
    const action = parts[0];
    const reqId  = parts[1];

    if (action === 'accept') {
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        await doAccept(chatId, userId, reqId);

    } else if (action === 'reject') {
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        adminState[userId] = { step: 'await_reject_reason', reqId };
        bot.sendMessage(chatId, '❌ Rejection-এর কারণ লিখুন:', CANCEL_KB);

    } else if (action === 'skip') {
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        if (!adminSkipped[userId]) adminSkipped[userId] = [];
        adminSkipped[userId].push(reqId);
        await showNextRequest(chatId, userId);
    }
});

// ─────────────────────────────────────────────────────────────────
// My Balance
// ─────────────────────────────────────────────────────────────────
async function showBalance(chatId, userId) {
    try {
        const user = await getUserByTgId(userId);
        if (!user) return sendLinkAccount(chatId);
        const cfg = await getConfig();
        const bal = user.balance || 0;
        const inr = cfg.coinValueCoins > 0 ? (Math.floor(bal / cfg.coinValueCoins) * cfg.coinValueInr) : 0;
        bot.sendMessage(chatId,
            `💰 *আপনার Balance*\n\n` +
            `🪙 Coins: *${bal}*\n` +
            `💵 Value: *₹${inr}*\n` +
            `📊 Rate: ${cfg.coinValueCoins} Coins = ₹${cfg.coinValueInr}\n` +
            `📉 Min Withdraw: *${cfg.minWithdrawal}* Coins\n\n` +
            (bal >= cfg.minWithdrawal
                ? `✅ Withdraw করতে পারবেন! "📤 Withdraw" বাটন চাপুন।`
                : `❌ আরও *${cfg.minWithdrawal - bal}* Coins দরকার।`),
            { parse_mode: 'Markdown' }
        );
    } catch (e) { console.error(e); bot.sendMessage(chatId, 'Error. আবার চেষ্টা করুন।'); }
}

// ─────────────────────────────────────────────────────────────────
// Withdraw — Step 0: Show amount options
// ─────────────────────────────────────────────────────────────────
async function startWithdraw(chatId, userId) {
    try {
        const user = await getUserByTgId(userId);
        if (!user) return sendLinkAccount(chatId);
        const cfg  = await getConfig();
        const bal  = user.balance || 0;

        if (bal < cfg.minWithdrawal) {
            bot.sendMessage(chatId,
                `❌ Balance কম। Minimum: *${cfg.minWithdrawal}* Coins\nআপনার Balance: *${bal}* Coins`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Build inline keyboard from admin-set options
        const opts    = cfg.withdrawalOptions.filter(o => o <= bal);
        const methods = cfg.paymentMethods;

        if (opts.length === 0) {
            bot.sendMessage(chatId, '⚠️ কোনো withdrawal option সেট নেই। Admin Panel → App Settings → Withdrawal Options-এ amount যোগ করুন।');
            return;
        }
        if (methods.length === 0) {
            bot.sendMessage(chatId, '⚠️ কোনো payment method সেট নেই। Admin Panel → App Settings-এ যোগ করুন।');
            return;
        }

        // Coin amount selection
        const rows = [];
        let row = [];
        opts.forEach((o, i) => {
            row.push({ text: `🪙 ${o} Coins`, callback_data: `wd|${o}` });
            if (row.length === 3 || i === opts.length - 1) { rows.push(row); row = []; }
        });

        // Method selection will come after amount — store method in flow later
        // For now, store available methods and start flow
        wState[userId] = { step: 'selecting_amount', data: { methods, userId: user.id, userName: user.name, userEmail: user.email, balance: bal } };

        bot.sendMessage(chatId,
            `📤 *Withdrawal Amount বেছে নিন*\n\nআপনার Balance: *${bal} Coins*`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: rows }
            }
        );
    } catch (e) { console.error(e); bot.sendMessage(chatId, 'Error. আবার চেষ্টা করুন।'); }
}

// After amount selected via inline button
async function confirmAmountSelected(chatId, userId, amount) {
    const state = wState[userId];
    if (!state) {
        await startWithdraw(chatId, userId);
        return;
    }

    const user = await getUserByTgId(userId);
    if (!user || (user.balance || 0) < amount) {
        bot.sendMessage(chatId, '❌ Balance অপর্যাপ্ত।');
        delete wState[userId];
        return;
    }

    state.data.amount = amount;
    const methods = state.data.methods || [];

    if (methods.length === 1) {
        // Only one method — skip selection
        state.data.method = methods[0];
        state.step = 'ask_qr';
        bot.sendMessage(chatId,
            `✅ Amount: *${amount} Coins* | Method: *${methods[0]}*\n\n📸 এখন আপনার *QR Code* ছবি পাঠান:`,
            { parse_mode: 'Markdown', ...CANCEL_KB }
        );
    } else {
        // Multiple methods — show as inline keyboard
        state.step = 'selecting_method';
        const methodRows = methods.map(m => [{ text: `💳 ${m}`, callback_data: `wd|method|${m}` }]);
        bot.sendMessage(chatId,
            `✅ Amount: *${amount} Coins*\n\n💳 Payment Method বেছে নিন:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: methodRows } }
        );
    }
}

// ─────────────────────────────────────────────────────────────────
// Withdrawal flow — text/photo messages
// ─────────────────────────────────────────────────────────────────
async function handleWithdrawFlow(msg) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text   = msg.text  || '';
    const photo  = msg.photo;
    const state  = wState[userId];
    if (!state) return;

    if (text === '❌ Cancel') {
        delete wState[userId];
        bot.sendMessage(chatId, '❌ Withdrawal বাতিল।', { reply_markup: { remove_keyboard: true } });
        setTimeout(() => bot.sendMessage(chatId, '🏠 Main Menu', MAIN_MENU), 500);
        return;
    }

    // ── QR photo step ──────────────────────────────────────────────
    if (state.step === 'ask_qr') {
        if (!photo) { bot.sendMessage(chatId, '📸 QR Code-এর ছবি পাঠান।'); return; }
        try {
            const fileId  = photo[photo.length - 1].file_id;
            const fileUrl = await bot.getFileLink(fileId);
            const fname   = `qr_${userId}_${Date.now()}.jpg`;
            const fpath   = path.join(UPLOAD_DIR, fname);
            await downloadFile(fileUrl, fpath);
            state.data.qrCodeUrl   = `${SERVER_URL}/uploads/${fname}`;
            state.data.qrLocalPath = fpath;
            state.step = 'ask_account_name';
            bot.sendMessage(chatId,
                `✅ QR Code পাওয়া গেছে!\n\n👤 আপনার *Account Holder Name* লিখুন:`,
                { parse_mode: 'Markdown', ...CANCEL_KB }
            );
        } catch (e) { console.error(e); bot.sendMessage(chatId, '❌ QR upload error. আবার চেষ্টা করুন।'); }
        return;
    }

    // ── Account name step ──────────────────────────────────────────
    if (state.step === 'ask_account_name') {
        if (text.trim().length < 2) { bot.sendMessage(chatId, '❌ সঠিক নাম লিখুন।'); return; }
        state.data.accountName = text.trim();
        await submitWithdrawal(chatId, userId);
        return;
    }
}

// ─────────────────────────────────────────────────────────────────
// Submit withdrawal to Firebase
// ─────────────────────────────────────────────────────────────────
async function submitWithdrawal(chatId, userId) {
    const state = wState[userId];
    try {
        // Final balance check
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
        // Save request
        const ref = await db.collection('withdrawals').add({
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
        const caption =
            `🔔 *New Withdrawal Request!*\n\n` +
            `👤 Name: ${state.data.userName}\n` +
            `📧 Email: ${state.data.userEmail}\n` +
            `💳 Method: ${state.data.method}\n` +
            `🪙 Amount: *${state.data.amount} Coins*\n` +
            `👤 Account: ${state.data.accountName}\n` +
            `🆔 ID: \`${ref.id}\`\n\n` +
            `/admin লিখে Approve/Reject করুন`;

        for (const adminId of ADMIN_IDS) {
            try {
                await bot.sendPhoto(adminId, state.data.qrLocalPath, { caption, parse_mode: 'Markdown' });
            } catch {
                try { await bot.sendMessage(adminId, caption, { parse_mode: 'Markdown' }); } catch (_) {}
            }
        }
        delete wState[userId];
        bot.sendMessage(chatId,
            `✅ *Request Submitted!*\n\n` +
            `আপনার *${state.data.amount} Coins* Withdrawal জমা হয়েছে।\n` +
            `24-48 ঘণ্টায় Process হবে। App-এ Notification পাবেন।`,
            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
        setTimeout(() => bot.sendMessage(chatId, '🏠 Main Menu', MAIN_MENU), 800);
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Submit error. আবার চেষ্টা করুন।');
    }
}

// ─────────────────────────────────────────────────────────────────
// /admin — Show next pending request
// ─────────────────────────────────────────────────────────────────
async function showNextRequest(chatId, adminId) {
    try {
        const skipped = adminSkipped[adminId] || [];
        const snap = await db.collection('withdrawals')
            .where('status', '==', 'pending')
            .orderBy('requestedAt', 'asc')
            .get();

        const docs = snap.docs.filter(d => !skipped.includes(d.id));

        if (docs.length === 0) {
            bot.sendMessage(chatId,
                skipped.length > 0
                    ? `✅ Skipped requests বাদে কোনো pending নেই।\n/admin লিখলে সব দেখাবে।`
                    : `✅ কোনো pending withdrawal নেই।`
            );
            adminSkipped[adminId] = [];
            return;
        }

        const d = docs[0];
        const r = d.data();
        const date = r.requestedAt?.toDate?.()?.toLocaleString('bn-BD') || 'N/A';

        const caption =
            `🔔 *Withdrawal Request* (${docs.length} pending)\n\n` +
            `🆔 ID: \`${d.id}\`\n` +
            `👤 User: *${r.userName}*\n` +
            `📧 Email: ${r.userEmail}\n` +
            `💳 Method: *${r.method}*\n` +
            `🪙 Amount: *${r.amount} Coins*\n` +
            `👤 Account: *${r.accountName}*\n` +
            `📅 Date: ${date}`;

        const keyboard = {
            inline_keyboard: [[
                { text: '✅ Accept', callback_data: `accept|${d.id}` },
                { text: '❌ Reject', callback_data: `reject|${d.id}` },
                { text: '⏭️ Skip',  callback_data: `skip|${d.id}`   }
            ]]
        };

        try {
            if (r.qrCodeUrl) {
                await bot.sendPhoto(chatId, r.qrCodeUrl, {
                    caption, parse_mode: 'Markdown', reply_markup: keyboard
                });
            } else {
                await bot.sendMessage(chatId, caption, {
                    parse_mode: 'Markdown', reply_markup: keyboard
                });
            }
        } catch (e) {
            // Photo URL broken — send text
            await bot.sendMessage(chatId, caption, {
                parse_mode: 'Markdown', reply_markup: keyboard
            });
        }
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Error loading requests.');
    }
}

// ─────────────────────────────────────────────────────────────────
// Admin: Accept
// ─────────────────────────────────────────────────────────────────
async function doAccept(chatId, adminId, reqId) {
    try {
        const reqDoc = await db.collection('withdrawals').doc(reqId).get();
        if (!reqDoc.exists || reqDoc.data().status !== 'pending') {
            bot.sendMessage(chatId, '⚠️ Request পাওয়া যায়নি বা আগেই process হয়েছে।');
            return;
        }
        const r = reqDoc.data();
        await db.collection('withdrawals').doc(reqId).update({
            status: 'approved', processedAt: FieldValue.serverTimestamp()
        });
        // Notify user in Firebase
        await db.collection('user_notifications').add({
            userId:    r.userId,
            type:      'approved',
            title:     '✅ Withdrawal Approved!',
            message:   `আপনার ${r.amount} Coins Withdrawal Approve হয়েছে। Payment পাঠানো হচ্ছে।`,
            createdAt: FieldValue.serverTimestamp()
        });
        // Notify user in bot
        try {
            await bot.sendMessage(r.telegramId,
                `✅ *আপনার Withdrawal Approved!*\n\n` +
                `💳 Method: ${r.method}\n🪙 Amount: *${r.amount} Coins*\n👤 Account: ${r.accountName}\n\n` +
                `Payment process শুরু হয়েছে।`,
                { parse_mode: 'Markdown', ...MAIN_MENU }
            );
        } catch (_) {}

        bot.sendMessage(chatId, `✅ *Approved!* ${r.userName}-এর ${r.amount} Coins request accept করা হয়েছে।`, { parse_mode: 'Markdown' });
        // Show next
        if (!adminSkipped[adminId]) adminSkipped[adminId] = [];
        adminSkipped[adminId].push(reqId);
        setTimeout(() => showNextRequest(chatId, adminId), 1000);
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Error accepting.');
    }
}

// ─────────────────────────────────────────────────────────────────
// Admin: Reject
// ─────────────────────────────────────────────────────────────────
async function doReject(chatId, adminId, reason) {
    const state = adminState[adminId];
    if (!state) return;
    const { reqId } = state;
    delete adminState[adminId];

    try {
        const reqDoc = await db.collection('withdrawals').doc(reqId).get();
        if (!reqDoc.exists || reqDoc.data().status !== 'pending') {
            bot.sendMessage(chatId, '⚠️ Request পাওয়া যায়নি।', { reply_markup: { remove_keyboard: true } });
            return;
        }
        const r = reqDoc.data();
        await db.collection('withdrawals').doc(reqId).update({
            status: 'rejected', reason, processedAt: FieldValue.serverTimestamp()
        });
        // Refund coins
        await db.collection('users').doc(r.userId).update({
            balance: FieldValue.increment(r.amount)
        });
        // Notify user in Firebase
        await db.collection('user_notifications').add({
            userId:    r.userId,
            type:      'rejected',
            title:     '❌ Withdrawal Rejected',
            message:   `আপনার ${r.amount} Coins Withdrawal Reject হয়েছে। কারণ: ${reason}। Coins ফেরত দেওয়া হয়েছে।`,
            createdAt: FieldValue.serverTimestamp()
        });
        // Notify user in bot
        try {
            await bot.sendMessage(r.telegramId,
                `❌ *Withdrawal Rejected*\n\n` +
                `🪙 Amount: *${r.amount} Coins*\n` +
                `❓ কারণ: ${reason}\n\n` +
                `Coins আপনার account-এ ফেরত দেওয়া হয়েছে।`,
                { parse_mode: 'Markdown', ...MAIN_MENU }
            );
        } catch (_) {}

        bot.sendMessage(chatId,
            `❌ *Rejected!* ${r.userName}-এর request reject করা হয়েছে।\nCoins refund হয়েছে।`,
            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
        // Show next
        if (!adminSkipped[adminId]) adminSkipped[adminId] = [];
        adminSkipped[adminId].push(reqId);
        setTimeout(() => showNextRequest(chatId, adminId), 1000);
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Error rejecting.', { reply_markup: { remove_keyboard: true } });
    }
}

// ─────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────
async function showStats(chatId, userId) {
    try {
        const user = await getUserByTgId(userId);
        if (!user) return sendLinkAccount(chatId);
        const snap = await db.collection('withdrawals').where('userId', '==', user.id).get();
        const approved = snap.docs.filter(d => d.data().status === 'approved').reduce((s, d) => s + d.data().amount, 0);
        const pending  = snap.docs.filter(d => d.data().status === 'pending').length;
        bot.sendMessage(chatId,
            `📊 *Your Stats*\n\n` +
            `👤 Name: ${user.name}\n` +
            `🪙 Balance: *${user.balance || 0}* Coins\n` +
            `✅ Total Withdrawn: *${approved}* Coins\n` +
            `⏳ Pending: *${pending}*\n` +
            `📋 Total Requests: *${snap.size}*`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) { bot.sendMessage(chatId, 'Error loading stats.'); }
}

// ─────────────────────────────────────────────────────────────────
// Help
// ─────────────────────────────────────────────────────────────────
function showHelp(chatId) {
    bot.sendMessage(chatId,
        `🆘 *Help — RN Coin Hunt*\n\n` +
        `*🪙 Coin আয় করুন (App-এ):*\n` +
        `• প্রতিদিন Check-in\n• Video Ads দেখুন\n• Math Quiz সমাধান করুন\n• বন্ধুদের Refer করুন\n\n` +
        `*📤 Withdraw করুন:*\n` +
        `"📤 Withdraw" বাটন চাপুন\n→ Amount বেছে নিন\n→ QR Code পাঠান\n→ Account নাম দিন\n→ Request Submit!\n\n` +
        `*👨‍💼 Admin (শুধু Admin):*\n` +
        `/admin লিখুন → Withdrawal requests দেখুন → Accept/Reject/Skip করুন`,
        { parse_mode: 'Markdown' }
    );
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function sendLinkAccount(chatId) {
    bot.sendMessage(chatId,
        `⚠️ *Account linked নেই!*\n\nআগে App খুলুন → Login করুন → তারপর এখানে আসুন।`,
        { parse_mode: 'Markdown', reply_markup: {
            keyboard: [[{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }]],
            resize_keyboard: true
        }}
    );
}

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
            minWithdrawal:     d.minWithdrawal    || 5000,
            coinValueCoins:    d.coinValueCoins   || 1000,
            coinValueInr:      d.coinValueInr     || 10,
            paymentMethods:    d.paymentMethods   || [],
            withdrawalOptions: (d.withdrawalOptions || []).map(Number).sort((a, b) => a - b)
        };
    } catch {
        return { minWithdrawal: 5000, coinValueCoins: 1000, coinValueInr: 10, paymentMethods: [], withdrawalOptions: [] };
    }
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

// ─────────────────────────────────────────────────────────────────
// Express — serves QR uploads
// ─────────────────────────────────────────────────────────────────
const app = express();
app.use('/uploads', express.static(UPLOAD_DIR));
app.get('/', (_, res) => res.send('🤖 RN Coin Hunt Bot running!'));
app.listen(PORT, () => console.log(`Bot server on port ${PORT}`));

console.log('🤖 RN Coin Hunt Bot started!');
