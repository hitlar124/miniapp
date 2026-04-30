// ─────────────────────────────────────────────────────────────────
// RN Coin Hunt — Telegram Bot (runs in-process with main server)
// ─────────────────────────────────────────────────────────────────
const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue }  = require('firebase-admin/firestore');
const path    = require('path');
const fs      = require('fs');

// ── Config ────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN  || '';
// Accept both ADMIN_IDS (newer) and ADMIN_TELEGRAM_IDS (older) for compatibility
const ADMIN_IDS    = (process.env.ADMIN_IDS || process.env.ADMIN_TELEGRAM_IDS || '')
                        .split(',').map(s => s.trim()).filter(Boolean);
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const SERVER_URL   = process.env.SERVER_URL   || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';

// ── Startup diagnostics — print what's missing ───────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 Bot startup check:');
const checks = [
    ['BOT_TOKEN',                 !!BOT_TOKEN,                                    'Required — bot will not start'],
    ['ADMIN_IDS',                 ADMIN_IDS.length > 0,                           'Required — /admin commands will not work'],
    ['MINI_APP_URL',              !!MINI_APP_URL,                                 'Required — "Open App" button will be broken'],
    ['SERVER_URL',                !!SERVER_URL,                                   'Required — QR uploads will be broken'],
    ['BOT_USERNAME',              !!BOT_USERNAME,                                 'Optional — needed for referral links'],
    ['FIREBASE_SERVICE_ACCOUNT',  !!(process.env.FIREBASE_SERVICE_ACCOUNT || ''), 'Required — Balance / Withdraw will not work'],
];
checks.forEach(([name, ok, note]) => {
    console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(28)} ${ok ? 'set' : `MISSING — ${note}`}`);
});
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ── Firebase Admin ────────────────────────────────────────────────
let firebaseReady = false;
try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    if (raw && raw.trim().startsWith('{')) {
        initializeApp({ credential: cert(JSON.parse(raw)) });
        firebaseReady = true;
    } else {
        console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — Firebase features disabled.');
    }
} catch (e) { console.error('Firebase init error:', e.message); }
const db = firebaseReady ? getFirestore() : null;

// ── Bot ───────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
    console.error('');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ BOT_TOKEN environment variable is missing!');
    console.error('');
    console.error('To activate the Telegram bot:');
    console.error('  1. Go to @BotFather on Telegram → /newbot or /mybots');
    console.error('  2. Copy the bot token');
    console.error('  3. Add it as a secret named: BOT_TOKEN');
    console.error('  4. Restart this workflow');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('');
    // Bot disabled — main server keeps running.
    module.exports = { uploadDir: null, enabled: false };
    return;
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// QR uploads directory
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── In-memory state ───────────────────────────────────────────────
const wState       = {};  // userId  → { step, data }   (user withdrawal flow)
const adminState   = {};  // adminId → { step, reqId, userId, amount }
const adminSkipped = {};  // adminId → [reqId, ...]      (for skip navigation)

// ── Bot Commands menu (left "Menu" button in the chat input) ──────
bot.setMyCommands([
    { command: 'start',    description: '🏠 Main Menu' },
    { command: 'menu',     description: '🏠 Show Main Menu' },
    { command: 'balance',  description: '💰 Check balance' },
    { command: 'withdraw', description: '📤 Withdraw coins' },
    { command: 'referral', description: '👥 My referral link' },
    { command: 'help',     description: '🆘 Help & support' },
]).catch(e => console.error('setMyCommands error:', e.message));

// Set the menu button to open the Mini App directly
bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🪙 Open App', web_app: { url: MINI_APP_URL } }
}).catch(e => console.error('setChatMenuButton error:', e.message));

// ── Reply keyboard (small persistent keyboard, just Open App + Menu) ──
function replyKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }],
                [{ text: '🏠 Main Menu' }]
            ],
            resize_keyboard: true,
            persistent: true
        }
    };
}

const CANCEL_KB = {
    reply_markup: {
        keyboard: [[{ text: '❌ Cancel' }]],
        resize_keyboard: true
    }
};

// ── Inline Main Menu (3-column grid like the screenshot) ──────────
function mainMenuInline(appUrl) {
    return {
        inline_keyboard: [
            [
                { text: '📋 Tasks',        web_app: { url: appUrl } },
                { text: '💰 Balance',      callback_data: 'menu|balance' },
            ],
            [
                { text: '💬 Help',         callback_data: 'menu|help' },
                { text: '👥 Referral',     callback_data: 'menu|referral' },
            ],
            [
                { text: '🎟️ Free Coupon',  callback_data: 'menu|freecoupon' },
                { text: '🎁 Claim Coupon', callback_data: 'menu|claimcoupon' },
            ],
            [
                { text: '🪪 My ID',        callback_data: 'menu|myid' },
                { text: '📜 Policy',       callback_data: 'menu|policy' },
            ],
            [
                { text: '📅 Check In',     web_app: { url: appUrl } },
            ],
            [
                { text: '📤 Withdraw',     callback_data: 'menu|withdraw' },
            ]
        ]
    };
}

async function sendMainMenu(chatId, userName, startParam) {
    const appUrl = startParam ? `${MINI_APP_URL}?start=${startParam}` : MINI_APP_URL;

    if (userName) {
        await bot.sendMessage(chatId,
            `🎉 *Welcome ${userName}!*\n\n` +
            `Earn coins by completing tasks and withdraw anytime.`,
            { parse_mode: 'Markdown' }
        );
    }

    await bot.sendMessage(chatId, `🏠 *Main Menu*`, {
        parse_mode: 'Markdown',
        reply_markup: mainMenuInline(appUrl)
    });
}

// ─────────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param  = (match[1] || '').trim().replace(/^\//, '');
    const name   = msg.from.first_name || msg.from.username || 'there';

    // Ensure the persistent reply keyboard is visible
    await bot.sendMessage(chatId,
        `👋 Hi *${name}*!`,
        { parse_mode: 'Markdown', ...replyKeyboard() }
    );

    await sendMainMenu(chatId, name, param);
});

// ─────────────────────────────────────────────────────────────────
// /menu, /balance, /withdraw, /referral, /help — quick commands
// ─────────────────────────────────────────────────────────────────
bot.onText(/\/menu$/, (msg) => sendMainMenu(msg.chat.id, msg.from.first_name, ''));
bot.onText(/\/balance$/, (msg) => showBalance(msg.chat.id, String(msg.from.id)));
bot.onText(/\/withdraw$/, (msg) => startWithdraw(msg.chat.id, String(msg.from.id)));
bot.onText(/\/referral$/, (msg) => showReferral(msg.chat.id, String(msg.from.id)));
bot.onText(/\/help$/, (msg) => showHelp(msg.chat.id));

// ─────────────────────────────────────────────────────────────────
// Single message handler
// ─────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text   = msg.text  || '';
    const photo  = msg.photo;

    if (text.startsWith('/')) return; // commands handled by onText above

    // ── Admin: waiting for reject reason ──────────────────────────
    if (adminState[userId]?.step === 'await_reject_reason') {
        if (text === '❌ Cancel') {
            delete adminState[userId];
            bot.sendMessage(chatId, 'বাতিল করা হয়েছে।', { reply_markup: { remove_keyboard: true } });
            setTimeout(() => sendMainMenu(chatId, msg.from.first_name, ''), 400);
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

    // ── Reply-keyboard buttons ────────────────────────────────────
    if (text === '🏠 Main Menu') { await sendMainMenu(chatId, msg.from.first_name, ''); return; }
});

// ─────────────────────────────────────────────────────────────────
// Inline button callback handler
// ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    const msgId  = query.message.message_id;
    const data   = query.data || '';

    bot.answerCallbackQuery(query.id).catch(() => {});

    // ── Main Menu actions ──
    if (data.startsWith('menu|')) {
        const action = data.split('|')[1];
        switch (action) {
            case 'balance':      await showBalance(chatId, userId); break;
            case 'withdraw':     await startWithdraw(chatId, userId); break;
            case 'help':         showHelp(chatId); break;
            case 'referral':     await showReferral(chatId, userId); break;
            case 'myid':         await showMyId(chatId, userId, query.from); break;
            case 'policy':       showPolicy(chatId); break;
            case 'freecoupon':   showFreeCoupon(chatId); break;
            case 'claimcoupon':  showClaimCoupon(chatId); break;
        }
        return;
    }

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
// /admin — entry
// ─────────────────────────────────────────────────────────────────
bot.onText(/^\/admin$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    if (!ADMIN_IDS.includes(userId)) {
        bot.sendMessage(chatId, '⛔ আপনি admin নন।');
        return;
    }
    adminSkipped[userId] = [];
    await showNextRequest(chatId, userId);
});

// ─────────────────────────────────────────────────────────────────
// My Balance
// ─────────────────────────────────────────────────────────────────
async function showBalance(chatId, userId) {
    if (!db) return bot.sendMessage(chatId, '⚠️ Firebase not configured.');
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
    if (!db) return bot.sendMessage(chatId, '⚠️ Firebase not configured.');
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
        state.data.method = methods[0];
        state.step = 'ask_qr';
        bot.sendMessage(chatId,
            `✅ Amount: *${amount} Coins* | Method: *${methods[0]}*\n\n📸 এখন আপনার *QR Code* ছবি পাঠান:`,
            { parse_mode: 'Markdown', ...CANCEL_KB }
        );
    } else {
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
        setTimeout(() => sendMainMenu(chatId, msg.from.first_name, ''), 400);
        return;
    }

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
        const user = await getUserByTgId(userId);
        if (!user || (user.balance || 0) < state.data.amount) {
            bot.sendMessage(chatId, '❌ Balance অপর্যাপ্ত।');
            delete wState[userId];
            return;
        }
        await db.collection('users').doc(state.data.userId).update({
            balance: FieldValue.increment(-state.data.amount)
        });
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
        setTimeout(() => sendMainMenu(chatId, '', ''), 800);
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Submit error. আবার চেষ্টা করুন।');
    }
}

// ─────────────────────────────────────────────────────────────────
// /admin — Show next pending request
// ─────────────────────────────────────────────────────────────────
async function showNextRequest(chatId, adminId) {
    if (!db) return bot.sendMessage(chatId, '⚠️ Firebase not configured.');
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
        await db.collection('user_notifications').add({
            userId:    r.userId,
            type:      'approved',
            title:     '✅ Withdrawal Approved!',
            message:   `আপনার ${r.amount} Coins Withdrawal Approve হয়েছে। Payment পাঠানো হচ্ছে।`,
            createdAt: FieldValue.serverTimestamp()
        });
        try {
            await bot.sendMessage(r.telegramId,
                `✅ *আপনার Withdrawal Approved!*\n\n` +
                `💳 Method: ${r.method}\n🪙 Amount: *${r.amount} Coins*\n👤 Account: ${r.accountName}\n\n` +
                `Payment process শুরু হয়েছে।`,
                { parse_mode: 'Markdown' }
            );
        } catch (_) {}

        bot.sendMessage(chatId, `✅ *Approved!* ${r.userName}-এর ${r.amount} Coins request accept করা হয়েছে।`, { parse_mode: 'Markdown' });
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
        await db.collection('users').doc(r.userId).update({
            balance: FieldValue.increment(r.amount)
        });
        await db.collection('user_notifications').add({
            userId:    r.userId,
            type:      'rejected',
            title:     '❌ Withdrawal Rejected',
            message:   `আপনার ${r.amount} Coins Withdrawal Reject হয়েছে। কারণ: ${reason}। Coins ফেরত দেওয়া হয়েছে।`,
            createdAt: FieldValue.serverTimestamp()
        });
        try {
            await bot.sendMessage(r.telegramId,
                `❌ *Withdrawal Rejected*\n\n` +
                `🪙 Amount: *${r.amount} Coins*\n` +
                `❓ কারণ: ${reason}\n\n` +
                `Coins আপনার account-এ ফেরত দেওয়া হয়েছে।`,
                { parse_mode: 'Markdown' }
            );
        } catch (_) {}

        bot.sendMessage(chatId,
            `❌ *Rejected!* ${r.userName}-এর request reject করা হয়েছে।\nCoins refund হয়েছে।`,
            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
        if (!adminSkipped[adminId]) adminSkipped[adminId] = [];
        adminSkipped[adminId].push(reqId);
        setTimeout(() => showNextRequest(chatId, adminId), 1000);
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Error rejecting.', { reply_markup: { remove_keyboard: true } });
    }
}

// ─────────────────────────────────────────────────────────────────
// Referral
// ─────────────────────────────────────────────────────────────────
async function showReferral(chatId, userId) {
    if (!db) return bot.sendMessage(chatId, '⚠️ Firebase not configured.');
    try {
        const user = await getUserByTgId(userId);
        if (!user) return sendLinkAccount(chatId);
        const code = user.referralCode || '—';
        const link = BOT_USERNAME
            ? `https://t.me/${BOT_USERNAME}?start=${code}`
            : `${MINI_APP_URL}?start=${code}`;
        bot.sendMessage(chatId,
            `👥 *Refer & Earn*\n\n` +
            `Your Code: \`${code}\`\n\n` +
            `Share this link with friends:\n${link}\n\n` +
            `যখন কেউ এই link দিয়ে join করে আপনি bonus পাবেন!`,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
    } catch (e) { console.error(e); bot.sendMessage(chatId, 'Error loading referral.'); }
}

// ─────────────────────────────────────────────────────────────────
// My ID
// ─────────────────────────────────────────────────────────────────
async function showMyId(chatId, userId, from) {
    let accountInfo = '';
    if (db) {
        try {
            const user = await getUserByTgId(userId);
            if (user) {
                accountInfo =
                    `\n\n🔗 *Linked Account*\n` +
                    `Name: *${user.name || '—'}*\n` +
                    `Email: ${user.email || '—'}\n` +
                    `Balance: *${user.balance || 0}* Coins`;
            } else {
                accountInfo = `\n\n⚠️ App account এখনো link হয়নি।\n"🪙 Open App" দিয়ে login করুন।`;
            }
        } catch (_) {}
    }
    bot.sendMessage(chatId,
        `🪪 *Your Telegram ID*\n\n` +
        `🆔 ID: \`${userId}\`\n` +
        `👤 Name: ${from.first_name || ''} ${from.last_name || ''}\n` +
        (from.username ? `🔖 Username: @${from.username}\n` : '') +
        accountInfo,
        { parse_mode: 'Markdown' }
    );
}

// ─────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────
function showPolicy(chatId) {
    bot.sendMessage(chatId,
        `📜 *App Policy*\n\n` +
        `*1.* প্রতিদিন একবার Check-in করা যাবে।\n` +
        `*2.* Multiple account তৈরি করলে ban হবে।\n` +
        `*3.* Fake referral / bot use করলে account ban হবে।\n` +
        `*4.* Withdrawal 24-48 ঘণ্টায় process হয়।\n` +
        `*5.* QR Code এবং Account নাম সঠিক দিতে হবে।\n` +
        `*6.* ভুল information দিলে coin refund হবে না।\n\n` +
        `Admin-এর সিদ্ধান্ত চূড়ান্ত।`,
        { parse_mode: 'Markdown' }
    );
}

// ─────────────────────────────────────────────────────────────────
// Coupons (placeholders — wire up when coupon system is added)
// ─────────────────────────────────────────────────────────────────
function showFreeCoupon(chatId) {
    bot.sendMessage(chatId,
        `🎟️ *Free Coupon*\n\n` +
        `এখনো কোনো free coupon available নেই।\n` +
        `Admin নতুন coupon publish করলে এখানে দেখাবে।`,
        { parse_mode: 'Markdown' }
    );
}

function showClaimCoupon(chatId) {
    bot.sendMessage(chatId,
        `🎁 *Claim a Coupon Code*\n\n` +
        `এই feature টি শীঘ্রই আসছে।\n` +
        `Coupon code পেলে App-এর Wallet section-এ গিয়ে redeem করতে পারবেন।`,
        { parse_mode: 'Markdown' }
    );
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
        `Main Menu থেকে "📤 Withdraw" চাপুন\n→ Amount বেছে নিন\n→ QR Code পাঠান\n→ Account নাম দিন\n→ Request Submit!\n\n` +
        `*Bot Commands:*\n` +
        `/menu — Main Menu\n/balance — Balance check\n/withdraw — Withdraw flow\n/referral — Referral link\n/help — এই message\n\n` +
        `*👨‍💼 Admin (শুধু Admin):*\n` +
        `/admin → Withdrawal requests দেখুন → Accept/Reject/Skip করুন`,
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
    if (!db) return null;
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
// Bot ready — main server.js handles HTTP (incl. /uploads/)
// ─────────────────────────────────────────────────────────────────
console.log('🤖 RN Coin Hunt Bot started (in-process with main server)');

module.exports = { uploadDir: UPLOAD_DIR, enabled: true };
