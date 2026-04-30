// ─────────────────────────────────────────────────────────────────
// RN Coin Hunt — Telegram Bot (in-process with main server)
// ─────────────────────────────────────────────────────────────────
const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const SERVER_URL   = process.env.SERVER_URL   || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';

// ── Startup diagnostics ──────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 Bot startup check:');
[
    ['BOT_TOKEN', !!BOT_TOKEN, 'Required — bot will not start'],
    ['ADMIN_IDS', ADMIN_IDS.length > 0, 'Required — admin commands disabled'],
    ['MINI_APP_URL', !!MINI_APP_URL, 'Required — Open App button broken'],
    ['SERVER_URL', !!SERVER_URL, 'Required — QR uploads broken'],
    ['BOT_USERNAME', !!BOT_USERNAME, 'Optional — referral links'],
    ['FIREBASE_SERVICE_ACCOUNT', !!(process.env.FIREBASE_SERVICE_ACCOUNT || ''), 'Required — DB features disabled'],
].forEach(([n, ok, note]) => console.log(`  ${ok ? '✅' : '❌'} ${n.padEnd(28)} ${ok ? 'set' : `MISSING — ${note}`}`));
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ── Firebase Admin ────────────────────────────────────────────────
let firebaseReady = false;
try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    if (raw && raw.trim().startsWith('{')) {
        initializeApp({ credential: cert(JSON.parse(raw)) });
        firebaseReady = true;
    }
} catch (e) { console.error('Firebase init error:', e.message); }
const db = firebaseReady ? getFirestore() : null;

// ── No token? Bail out ───────────────────────────────────────────
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN missing — bot disabled. Main server still runs.');
    module.exports = { enabled: false, sendMessage: async () => {}, broadcastToAll: async () => 0 };
    return;
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// QR uploads dir
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── In-memory state ──────────────────────────────────────────────
const wState = {};      // userId → withdrawal flow state
const adminState = {};  // adminId → admin flow state
const adminSkipped = {}; // adminId → array of skipped pending IDs
const adminBinSkipped = {}; // adminId → array of skipped bin IDs
const claimState = {};   // userId → expecting coupon code

// ── Bot Commands menu (only /start as requested) ─────────────────
bot.setMyCommands([
    { command: 'start', description: 'Open Main Menu' },
]).catch(e => console.error('setMyCommands error:', e.message));

bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'Open App', web_app: { url: MINI_APP_URL } }
}).catch(e => console.error('setChatMenuButton error:', e.message));

// ─────────────────────────────────────────────────────────────────
// User Main Menu
// ─────────────────────────────────────────────────────────────────
function userMainMenu(appUrl) {
    return {
        inline_keyboard: [
            [
                { text: '📋 Tasks',         web_app: { url: appUrl } },
                { text: '💰 Balance',       callback_data: 'u|balance' },
            ],
            [
                { text: '📤 Withdraw',      callback_data: 'u|withdraw' },
                { text: '🎁 Claim Coupon',  callback_data: 'u|claimcoupon' },
            ],
            [
                { text: '📢 Join Channel',  callback_data: 'u|channel' },
                { text: '🆘 Help',          callback_data: 'u|help' },
            ],
            [
                { text: '🪪 My ID',         callback_data: 'u|myid' },
                { text: '📜 Policy',        callback_data: 'u|policy' },
            ],
        ]
    };
}

function backToMenuKb() {
    return { inline_keyboard: [[{ text: '← Back to Menu', callback_data: 'u|menu' }]] };
}

async function sendUserMainMenu(chatId, fromName, startParam, asNewMessage = true) {
    const appUrl = MINI_APP_URL + (startParam ? `?start=${startParam}` : '');
    const text = `🏠 *Main Menu*\n\nWelcome${fromName ? ` ${fromName}` : ''}! Earn coins by completing tasks and withdraw anytime.`;
    if (asNewMessage) {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: userMainMenu(appUrl) });
    }
    return { text, markup: userMainMenu(appUrl) };
}

// ─────────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = (match[1] || '').trim().replace(/^\//, '');
    const name = msg.from.first_name || msg.from.username || '';
    await sendUserMainMenu(chatId, name, param, true);
});

// /admin
bot.onText(/^\/admin$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    if (!ADMIN_IDS.includes(userId)) {
        return bot.sendMessage(chatId, '⛔ You are not an admin.');
    }
    await sendAdminPanel(chatId);
});

// ─────────────────────────────────────────────────────────────────
// Message handler — picks up text/photo for active flows
// ─────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text || '';
    if (text.startsWith('/')) return;

    // Admin flows (broadcast / msguser / coupon / reject)
    if (adminState[userId] && ADMIN_IDS.includes(userId)) {
        await handleAdminFlow(msg);
        return;
    }

    // Coupon claim flow
    if (claimState[userId] && text) {
        await processCouponClaim(chatId, userId, text.trim());
        return;
    }

    // Withdrawal flow
    if (wState[userId]) {
        await handleWithdrawFlow(msg);
        return;
    }
});

// ─────────────────────────────────────────────────────────────────
// Callback dispatcher
// ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    const msgId  = query.message.message_id;
    const data   = query.data || '';
    bot.answerCallbackQuery(query.id).catch(() => {});

    try {
        // ── User menu ──
        if (data.startsWith('u|')) {
            const action = data.split('|')[1];
            if (action === 'menu')        await editToUserMenu(chatId, msgId, query.from.first_name);
            else if (action === 'balance')      await uShowBalance(chatId, msgId, userId);
            else if (action === 'withdraw')     await uStartWithdraw(chatId, userId);
            else if (action === 'claimcoupon')  await uClaimCouponPrompt(chatId, msgId, userId);
            else if (action === 'channel')      await uShowChannel(chatId, msgId);
            else if (action === 'help')         await uShowHelp(chatId, msgId);
            else if (action === 'myid')         await uShowMyId(chatId, msgId, userId, query.from);
            else if (action === 'policy')       await uShowPolicy(chatId, msgId);
            return;
        }

        // ── Withdrawal selection ──
        if (data.startsWith('wd|method|')) {
            const method = data.replace('wd|method|', '');
            const state = wState[userId];
            if (!state) return;
            state.data.method = method;
            state.step = 'ask_qr';
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
            await bot.sendMessage(chatId,
                `✅ Method: *${method}*\n\n📸 Now send your *QR Code* image:`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'wd|cancel' }]] } }
            );
            return;
        }
        if (data.startsWith('wd|amount|')) {
            const amount = parseInt(data.split('|')[2]);
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
            await wConfirmAmount(chatId, userId, amount);
            return;
        }
        if (data === 'wd|cancel') {
            delete wState[userId];
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
            await bot.sendMessage(chatId, '❌ Withdrawal cancelled.');
            await sendUserMainMenu(chatId, query.from.first_name, '', true);
            return;
        }

        // ── Admin panel ──
        if (!ADMIN_IDS.includes(userId)) return;
        if (data.startsWith('a|')) {
            const parts = data.split('|');
            const action = parts[1];

            if (action === 'panel')      return editToAdminPanel(chatId, msgId);
            if (action === 'pending')    return showPending(chatId, userId, msgId, true);
            if (action === 'bin')        return showBin(chatId, userId, msgId, true);
            if (action === 'broadcast')  return startBroadcast(chatId, userId, msgId);
            if (action === 'msguser')    return startMessageUser(chatId, userId, msgId);
            if (action === 'coupon')     return startCreateCoupon(chatId, userId, msgId);
            if (action === 'stats')      return showStats(chatId, userId, msgId);
            if (action === 'close') {
                bot.deleteMessage(chatId, msgId).catch(() => {});
                return;
            }

            // Pending request actions
            if (action === 'accept')  return doAccept(chatId, userId, parts[2], msgId);
            if (action === 'reject')  return askRejectReason(chatId, userId, parts[2], msgId);
            if (action === 'skip')    return doSkip(chatId, userId, parts[2], msgId);
            if (action === 'tobin')   return doToBin(chatId, userId, parts[2], msgId);

            // Bin actions
            if (action === 'binskip')    return doBinSkip(chatId, userId, parts[2], msgId);
            if (action === 'return')     return doReturn(chatId, userId, parts[2], msgId);

            // Cancel/confirm flows
            if (action === 'cancel') {
                delete adminState[userId];
                bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
                await bot.sendMessage(chatId, '❌ Cancelled.');
                await sendAdminPanel(chatId);
                return;
            }
            if (action === 'bcconfirm') {
                bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
                await doBroadcast(chatId, userId);
                return;
            }
            if (action === 'cpconfirm') {
                bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
                await doCreateCoupon(chatId, userId);
                return;
            }
        }
    } catch (e) {
        console.error('Callback error:', e);
        bot.sendMessage(chatId, '❌ Something went wrong. Please try again.').catch(() => {});
    }
});

// ─────────────────────────────────────────────────────────────────
// USER FUNCTIONS
// ─────────────────────────────────────────────────────────────────
async function editToUserMenu(chatId, msgId, name) {
    const appUrl = MINI_APP_URL;
    bot.editMessageText(
        `🏠 *Main Menu*\n\nWelcome${name ? ` ${name}` : ''}! Earn coins by completing tasks and withdraw anytime.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: userMainMenu(appUrl) }
    ).catch(() => sendUserMainMenu(chatId, name, '', true));
}

async function uShowBalance(chatId, msgId, userId) {
    if (!db) return safeEdit(chatId, msgId, '⚠️ Database not configured.', backToMenuKb());
    const user = await getUserByTgId(userId);
    if (!user) return promptLinkAccount(chatId, msgId);
    const cfg = await getAppConfig();
    const bal = user.balance || 0;
    const inr = cfg.coinValueCoins > 0 ? Math.floor(bal / cfg.coinValueCoins) * cfg.coinValueInr : 0;

    const txt =
        `💰 *Your Balance*\n\n` +
        `🪙 Coins: *${bal}*\n` +
        `💵 Value: *₹${inr}*\n` +
        `📊 Rate: ${cfg.coinValueCoins} Coins = ₹${cfg.coinValueInr}\n` +
        `📉 Min Withdrawal: *${cfg.minWithdrawal}* Coins\n\n` +
        (bal >= cfg.minWithdrawal ? '✅ You can withdraw now!' : `❌ Need ${cfg.minWithdrawal - bal} more coins.`);

    const markup = {
        inline_keyboard: [
            [{ text: '📤 Withdraw', callback_data: 'u|withdraw' }, { text: '📜 History', callback_data: 'u|history' }],
            [{ text: '← Back to Menu', callback_data: 'u|menu' }]
        ]
    };
    safeEdit(chatId, msgId, txt, markup);
}

async function uClaimCouponPrompt(chatId, msgId, userId) {
    claimState[userId] = true;
    safeEdit(chatId, msgId,
        `🎁 *Claim a Coupon*\n\nSend the coupon code now (just type it):`,
        { inline_keyboard: [[{ text: '← Back to Menu', callback_data: 'u|menu' }]] }
    );
}

async function processCouponClaim(chatId, userId, code) {
    delete claimState[userId];
    if (!db) return bot.sendMessage(chatId, '⚠️ Database not configured.', { reply_markup: backToMenuKb() });

    const user = await getUserByTgId(userId);
    if (!user) return bot.sendMessage(chatId,
        '⚠️ Account not linked. Open the app first to register, then come back.',
        { reply_markup: backToMenuKb() }
    );

    const codeUp = code.toUpperCase();
    try {
        const snap = await db.collection('coupons').where('code', '==', codeUp).limit(1).get();
        if (snap.empty) {
            return bot.sendMessage(chatId, `❌ Invalid code: *${codeUp}*`, { parse_mode: 'Markdown', reply_markup: backToMenuKb() });
        }
        const docRef = snap.docs[0].ref;
        const c = snap.docs[0].data();

        if ((c.usedCount || 0) >= (c.totalUses || 0)) {
            return bot.sendMessage(chatId, `❌ Coupon *${codeUp}* is fully claimed.`, { parse_mode: 'Markdown', reply_markup: backToMenuKb() });
        }
        if ((c.usedBy || []).includes(user.id)) {
            return bot.sendMessage(chatId, `⚠️ You already claimed *${codeUp}*.`, { parse_mode: 'Markdown', reply_markup: backToMenuKb() });
        }

        await docRef.update({
            usedCount: FieldValue.increment(1),
            usedBy: FieldValue.arrayUnion(user.id)
        });
        await db.collection('users').doc(user.id).update({
            balance: FieldValue.increment(c.coinsPerUser || 0)
        });
        await db.collection('user_notifications').add({
            userId: user.id,
            type: 'coupon',
            title: '🎁 Coupon Claimed!',
            message: `You claimed code ${codeUp} and got ${c.coinsPerUser} coins.`,
            createdAt: FieldValue.serverTimestamp()
        });

        bot.sendMessage(chatId,
            `✅ *Coupon Claimed!*\n\nCode: *${codeUp}*\n🪙 +${c.coinsPerUser} Coins added to your balance.`,
            { parse_mode: 'Markdown', reply_markup: backToMenuKb() }
        );
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Error claiming coupon.', { reply_markup: backToMenuKb() });
    }
}

async function uShowChannel(chatId, msgId) {
    const cfg = await getAppConfig();
    const link = (cfg.channelLink || '').trim();
    if (!link) {
        return safeEdit(chatId, msgId, '📢 *Channel*\n\nNo channel link set yet.', { parse_mode: 'Markdown', ...backToMenuKb() });
    }
    safeEdit(chatId, msgId,
        `📢 *Join Our Channel*\n\nClick the button below to join:`,
        {
            inline_keyboard: [
                [{ text: '🔗 Open Channel', url: link }],
                [{ text: '← Back to Menu', callback_data: 'u|menu' }]
            ]
        }
    );
}

async function uShowHelp(chatId, msgId) {
    const cfg = await getAppConfig();
    const link = (cfg.helpLink || '').trim();
    const buttons = [];
    if (link) buttons.push([{ text: '💬 Open Help Chat', url: link }]);
    buttons.push([{ text: '← Back to Menu', callback_data: 'u|menu' }]);

    safeEdit(chatId, msgId,
        `🆘 *Help & Support*\n\n` +
        (link
            ? `Tap the button below to chat with admin.`
            : `No help link set yet. Please contact admin directly.`),
        { inline_keyboard: buttons }
    );
}

async function uShowMyId(chatId, msgId, userId, from) {
    let extra = '';
    if (db) {
        const u = await getUserByTgId(userId);
        if (u) {
            extra =
                `\n\n🔗 *Linked Account*\n` +
                `Name: ${u.name || '—'}\n` +
                `Email: ${u.email || '—'}\n` +
                `Balance: ${u.balance || 0} Coins`;
        } else {
            extra = `\n\n⚠️ Account not linked yet. Open the app and sign in.`;
        }
    }
    safeEdit(chatId, msgId,
        `🪪 *Your Telegram ID*\n\n` +
        `🆔 ID: \`${userId}\`\n` +
        `👤 Name: ${from.first_name || ''} ${from.last_name || ''}\n` +
        (from.username ? `🔖 Username: @${from.username}\n` : '') +
        extra,
        backToMenuKb()
    );
}

async function uShowPolicy(chatId, msgId) {
    const cfg = await getAppConfig();
    const policy = (cfg.policyText || '').trim() || `No policy set yet. Please contact admin.`;
    safeEdit(chatId, msgId, `📜 *App Policy*\n\n${policy}`, backToMenuKb());
}

// ─────────────────────────────────────────────────────────────────
// Withdrawal flow (user-side)
// ─────────────────────────────────────────────────────────────────
async function uStartWithdraw(chatId, userId) {
    if (!db) return bot.sendMessage(chatId, '⚠️ Database not configured.');
    const user = await getUserByTgId(userId);
    if (!user) return promptLinkAccount(chatId);
    const cfg = await getAppConfig();
    const bal = user.balance || 0;

    if (bal < cfg.minWithdrawal) {
        return bot.sendMessage(chatId,
            `❌ Insufficient balance.\n\nMin: *${cfg.minWithdrawal}* Coins\nYou have: *${bal}* Coins`,
            { parse_mode: 'Markdown', reply_markup: backToMenuKb() }
        );
    }

    const opts = (cfg.withdrawalOptions || []).filter(o => o <= bal);
    const methods = cfg.paymentMethods || [];

    if (opts.length === 0) return bot.sendMessage(chatId, '⚠️ No withdrawal options set. Admin must add them.', { reply_markup: backToMenuKb() });
    if (methods.length === 0) return bot.sendMessage(chatId, '⚠️ No payment methods set. Admin must add them.', { reply_markup: backToMenuKb() });

    const rows = [];
    let row = [];
    opts.forEach((o, i) => {
        row.push({ text: `🪙 ${o}`, callback_data: `wd|amount|${o}` });
        if (row.length === 3 || i === opts.length - 1) { rows.push(row); row = []; }
    });
    rows.push([{ text: '❌ Cancel', callback_data: 'wd|cancel' }]);

    wState[userId] = { step: 'choose_amount', data: { methods, userId: user.id, userName: user.name, userEmail: user.email, balance: bal } };

    bot.sendMessage(chatId,
        `📤 *Choose Withdrawal Amount*\n\nYour Balance: *${bal} Coins*`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
    );
}

async function wConfirmAmount(chatId, userId, amount) {
    const state = wState[userId];
    if (!state) return uStartWithdraw(chatId, userId);

    const user = await getUserByTgId(userId);
    if (!user || (user.balance || 0) < amount) {
        delete wState[userId];
        return bot.sendMessage(chatId, '❌ Insufficient balance.', { reply_markup: backToMenuKb() });
    }
    state.data.amount = amount;
    const methods = state.data.methods;

    if (methods.length === 1) {
        state.data.method = methods[0];
        state.step = 'ask_qr';
        bot.sendMessage(chatId,
            `✅ Amount: *${amount}* | Method: *${methods[0]}*\n\n📸 Now send your *QR Code* image:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'wd|cancel' }]] } }
        );
    } else {
        state.step = 'choose_method';
        const methodRows = methods.map(m => [{ text: `💳 ${m}`, callback_data: `wd|method|${m}` }]);
        methodRows.push([{ text: '❌ Cancel', callback_data: 'wd|cancel' }]);
        bot.sendMessage(chatId,
            `✅ Amount: *${amount} Coins*\n\n💳 Choose payment method:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: methodRows } }
        );
    }
}

async function handleWithdrawFlow(msg) {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text || '';
    const photo = msg.photo;
    const state = wState[userId];
    if (!state) return;

    if (state.step === 'ask_qr') {
        if (!photo) return bot.sendMessage(chatId, '📸 Please send a QR Code image.');
        try {
            const fileId = photo[photo.length - 1].file_id;
            const fileUrl = await bot.getFileLink(fileId);
            const fname = `qr_${userId}_${Date.now()}.jpg`;
            const fpath = path.join(UPLOAD_DIR, fname);
            await downloadFile(fileUrl, fpath);
            state.data.qrCodeUrl = `${SERVER_URL}/uploads/${fname}`;
            state.data.qrLocalPath = fpath;
            state.step = 'ask_account_name';
            bot.sendMessage(chatId,
                `✅ QR received!\n\n👤 Now send your *Account Holder Name*:`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'wd|cancel' }]] } }
            );
        } catch (e) { console.error(e); bot.sendMessage(chatId, '❌ QR upload error. Try again.'); }
        return;
    }

    if (state.step === 'ask_account_name') {
        if (text.trim().length < 2) return bot.sendMessage(chatId, '❌ Please enter a valid name.');
        state.data.accountName = text.trim();
        await submitWithdrawal(chatId, userId);
        return;
    }
}

async function submitWithdrawal(chatId, userId) {
    const state = wState[userId];
    try {
        const user = await getUserByTgId(userId);
        if (!user || (user.balance || 0) < state.data.amount) {
            delete wState[userId];
            return bot.sendMessage(chatId, '❌ Insufficient balance.', { reply_markup: backToMenuKb() });
        }
        await db.collection('users').doc(state.data.userId).update({
            balance: FieldValue.increment(-state.data.amount)
        });
        const ref = await db.collection('withdrawals').add({
            userId: state.data.userId,
            userName: state.data.userName,
            userEmail: state.data.userEmail,
            telegramId: userId,
            amount: state.data.amount,
            method: state.data.method,
            accountName: state.data.accountName,
            qrCodeUrl: state.data.qrCodeUrl,
            status: 'pending',
            requestedAt: FieldValue.serverTimestamp()
        });

        // Notify admins
        const caption =
            `🔔 *New Withdrawal Request*\n\n` +
            `👤 ${state.data.userName}\n📧 ${state.data.userEmail}\n` +
            `💳 ${state.data.method} | 🪙 *${state.data.amount}*\n` +
            `👤 ${state.data.accountName}\n🆔 \`${ref.id}\``;
        for (const adminId of ADMIN_IDS) {
            try {
                await bot.sendPhoto(adminId, state.data.qrLocalPath, {
                    caption,
                    parse_mode: 'Markdown',
                    reply_markup: pendingActionsKb(ref.id)
                });
            } catch {
                bot.sendMessage(adminId, caption, { parse_mode: 'Markdown', reply_markup: pendingActionsKb(ref.id) }).catch(() => {});
            }
        }
        delete wState[userId];
        bot.sendMessage(chatId,
            `✅ *Request Submitted!*\n\nYour *${state.data.amount} Coins* withdrawal is being processed (24-48 hours).`,
            { parse_mode: 'Markdown', reply_markup: backToMenuKb() }
        );
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Submit error. Try again.');
    }
}

// ─────────────────────────────────────────────────────────────────
// ADMIN PANEL
// ─────────────────────────────────────────────────────────────────
function adminPanelKb() {
    return {
        inline_keyboard: [
            [{ text: '⏳ Pending Withdrawals', callback_data: 'a|pending' }],
            [{ text: '🗑️ Bin Requests',       callback_data: 'a|bin' }],
            [{ text: '📢 Broadcast',           callback_data: 'a|broadcast' }],
            [{ text: '👤 Message User',        callback_data: 'a|msguser' }],
            [{ text: '🎟️ Create Coupon',       callback_data: 'a|coupon' }],
            [{ text: '📊 Stats',               callback_data: 'a|stats' }],
            [{ text: '❌ Close',               callback_data: 'a|close' }],
        ]
    };
}

async function sendAdminPanel(chatId) {
    await bot.sendMessage(chatId, `👨‍💼 *Admin Panel*\n\nSelect an option:`, { parse_mode: 'Markdown', reply_markup: adminPanelKb() });
}
async function editToAdminPanel(chatId, msgId) {
    bot.editMessageText(`👨‍💼 *Admin Panel*\n\nSelect an option:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: adminPanelKb() }
    ).catch(() => sendAdminPanel(chatId));
}

function pendingActionsKb(reqId) {
    return {
        inline_keyboard: [
            [
                { text: '✅ Accept', callback_data: `a|accept|${reqId}` },
                { text: '❌ Reject', callback_data: `a|reject|${reqId}` },
            ],
            [
                { text: '⏭️ Skip',   callback_data: `a|skip|${reqId}`  },
                { text: '🗑️ To Bin', callback_data: `a|tobin|${reqId}` },
            ],
            [{ text: '🔙 Admin Panel', callback_data: 'a|panel' }]
        ]
    };
}

function binActionsKb(reqId) {
    return {
        inline_keyboard: [
            [
                { text: '⏭️ Skip',   callback_data: `a|binskip|${reqId}` },
                { text: '↩️ Return', callback_data: `a|return|${reqId}`  },
            ],
            [{ text: '🔙 Admin Panel', callback_data: 'a|panel' }]
        ]
    };
}

// ── Show pending request ──
async function showPending(chatId, adminId, msgId, fromPanel) {
    if (!db) return bot.sendMessage(chatId, '⚠️ Database not configured.');
    if (fromPanel && msgId) bot.deleteMessage(chatId, msgId).catch(() => {});

    const skipped = adminSkipped[adminId] || [];
    let snap;
    try {
        snap = await db.collection('withdrawals').where('status', '==', 'pending').get();
    } catch (e) {
        return bot.sendMessage(chatId, '❌ Error loading: ' + e.message, { reply_markup: adminPanelKb() });
    }

    // Sort client-side (avoids needing a Firestore composite index)
    const docs = snap.docs
        .filter(d => !skipped.includes(d.id))
        .sort((a, b) => {
            const ta = a.data().requestedAt?.toMillis?.() || 0;
            const tb = b.data().requestedAt?.toMillis?.() || 0;
            return ta - tb;
        });

    if (docs.length === 0) {
        adminSkipped[adminId] = [];
        return bot.sendMessage(chatId,
            skipped.length > 0
                ? `✅ No more pending requests (you skipped ${skipped.length}).`
                : `✅ No pending withdrawal requests.`,
            { reply_markup: adminPanelKb() }
        );
    }

    await renderPendingDoc(chatId, docs[0], docs.length);
}

async function renderPendingDoc(chatId, d, total) {
    const r = d.data();
    const date = r.requestedAt?.toDate?.()?.toLocaleString('en-IN') || 'N/A';
    const caption =
        `🔔 *Withdrawal Request* (${total} pending)\n\n` +
        `🆔 \`${d.id}\`\n` +
        `👤 *${r.userName}*\n📧 ${r.userEmail}\n` +
        `💳 *${r.method}* | 🪙 *${r.amount} Coins*\n` +
        `👤 *${r.accountName}*\n📅 ${date}`;

    try {
        if (r.qrCodeUrl) {
            await bot.sendPhoto(chatId, r.qrCodeUrl, { caption, parse_mode: 'Markdown', reply_markup: pendingActionsKb(d.id) });
        } else {
            await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: pendingActionsKb(d.id) });
        }
    } catch {
        await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: pendingActionsKb(d.id) });
    }
}

async function doAccept(chatId, adminId, reqId, msgId) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    try {
        const reqDoc = await db.collection('withdrawals').doc(reqId).get();
        if (!reqDoc.exists || reqDoc.data().status !== 'pending') {
            return bot.sendMessage(chatId, '⚠️ Already processed or not found.', { reply_markup: adminPanelKb() });
        }
        const r = reqDoc.data();
        await db.collection('withdrawals').doc(reqId).update({ status: 'approved', processedAt: FieldValue.serverTimestamp() });
        await db.collection('user_notifications').add({
            userId: r.userId, type: 'approved',
            title: '✅ Withdrawal Approved!',
            message: `Your ${r.amount} coins withdrawal has been approved.`,
            createdAt: FieldValue.serverTimestamp()
        });
        if (r.telegramId) {
            bot.sendMessage(r.telegramId,
                `✅ *Withdrawal Approved!*\n💳 ${r.method} | 🪙 *${r.amount} Coins*\n👤 ${r.accountName}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        bot.sendMessage(chatId, `✅ Approved ${r.userName}'s ${r.amount} coins request.`);
        if (!adminSkipped[adminId]) adminSkipped[adminId] = [];
        adminSkipped[adminId].push(reqId);
        setTimeout(() => showPending(chatId, adminId, null, false), 800);
    } catch (e) { console.error(e); bot.sendMessage(chatId, '❌ Error.'); }
}

async function askRejectReason(chatId, adminId, reqId, msgId) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    adminState[adminId] = { flow: 'reject', step: 'await_reason', reqId };
    bot.sendMessage(chatId, `❌ Send the *rejection reason* now (or tap Cancel):`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a|cancel' }]] }
    });
}

async function doReject(chatId, adminId, reason) {
    const state = adminState[adminId];
    if (!state) return;
    const reqId = state.reqId;
    delete adminState[adminId];

    try {
        const reqDoc = await db.collection('withdrawals').doc(reqId).get();
        if (!reqDoc.exists || reqDoc.data().status !== 'pending') {
            return bot.sendMessage(chatId, '⚠️ Already processed or not found.', { reply_markup: adminPanelKb() });
        }
        const r = reqDoc.data();
        await db.collection('withdrawals').doc(reqId).update({ status: 'rejected', reason, processedAt: FieldValue.serverTimestamp() });
        await db.collection('users').doc(r.userId).update({ balance: FieldValue.increment(r.amount) });
        await db.collection('user_notifications').add({
            userId: r.userId, type: 'rejected',
            title: '❌ Withdrawal Rejected',
            message: `Your ${r.amount} coins withdrawal was rejected. Reason: ${reason}. Coins refunded.`,
            createdAt: FieldValue.serverTimestamp()
        });
        if (r.telegramId) {
            bot.sendMessage(r.telegramId,
                `❌ *Withdrawal Rejected*\n🪙 *${r.amount} Coins* | Reason: ${reason}\nCoins refunded.`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        bot.sendMessage(chatId, `❌ Rejected ${r.userName}'s request. Coins refunded.`);
        if (!adminSkipped[adminId]) adminSkipped[adminId] = [];
        adminSkipped[adminId].push(reqId);
        setTimeout(() => showPending(chatId, adminId, null, false), 800);
    } catch (e) { console.error(e); bot.sendMessage(chatId, '❌ Error.'); }
}

async function doSkip(chatId, adminId, reqId, msgId) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    if (!adminSkipped[adminId]) adminSkipped[adminId] = [];
    adminSkipped[adminId].push(reqId);
    showPending(chatId, adminId, null, false);
}

async function doToBin(chatId, adminId, reqId, msgId) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    try {
        await db.collection('withdrawals').doc(reqId).update({
            status: 'binned',
            binnedAt: FieldValue.serverTimestamp()
        });
        bot.sendMessage(chatId, `🗑️ Moved to Bin.`);
        // remove from skipped list if present
        if (adminSkipped[adminId]) adminSkipped[adminId] = adminSkipped[adminId].filter(id => id !== reqId);
        setTimeout(() => showPending(chatId, adminId, null, false), 600);
    } catch (e) { console.error(e); bot.sendMessage(chatId, '❌ Error: ' + e.message); }
}

async function showBin(chatId, adminId, msgId, fromPanel) {
    if (!db) return bot.sendMessage(chatId, '⚠️ Database not configured.');
    if (fromPanel && msgId) bot.deleteMessage(chatId, msgId).catch(() => {});

    const skipped = adminBinSkipped[adminId] || [];
    let snap;
    try {
        snap = await db.collection('withdrawals').where('status', '==', 'binned').get();
    } catch (e) {
        return bot.sendMessage(chatId, '❌ Error loading: ' + e.message, { reply_markup: adminPanelKb() });
    }

    const docs = snap.docs
        .filter(d => !skipped.includes(d.id))
        .sort((a, b) => {
            const ta = a.data().binnedAt?.toMillis?.() || 0;
            const tb = b.data().binnedAt?.toMillis?.() || 0;
            return tb - ta;
        });

    if (docs.length === 0) {
        adminBinSkipped[adminId] = [];
        return bot.sendMessage(chatId, `🗑️ No more bin requests.`, { reply_markup: adminPanelKb() });
    }

    const d = docs[0];
    const r = d.data();
    const date = r.binnedAt?.toDate?.()?.toLocaleString('en-IN') || 'N/A';
    const caption =
        `🗑️ *Bin Request* (${docs.length} in bin)\n\n` +
        `🆔 \`${d.id}\`\n👤 *${r.userName}*\n📧 ${r.userEmail}\n` +
        `💳 *${r.method}* | 🪙 *${r.amount} Coins*\n👤 *${r.accountName}*\n📅 Binned: ${date}`;

    try {
        if (r.qrCodeUrl) await bot.sendPhoto(chatId, r.qrCodeUrl, { caption, parse_mode: 'Markdown', reply_markup: binActionsKb(d.id) });
        else await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: binActionsKb(d.id) });
    } catch {
        await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: binActionsKb(d.id) });
    }
}

async function doBinSkip(chatId, adminId, reqId, msgId) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    if (!adminBinSkipped[adminId]) adminBinSkipped[adminId] = [];
    adminBinSkipped[adminId].push(reqId);
    showBin(chatId, adminId, null, false);
}

async function doReturn(chatId, adminId, reqId, msgId) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    try {
        await db.collection('withdrawals').doc(reqId).update({
            status: 'pending',
            binnedAt: FieldValue.delete()
        });
        bot.sendMessage(chatId, `↩️ Returned to pending.`);
        if (adminSkipped[adminId]) adminSkipped[adminId] = adminSkipped[adminId].filter(id => id !== reqId);
        if (adminBinSkipped[adminId]) adminBinSkipped[adminId] = adminBinSkipped[adminId].filter(id => id !== reqId);
        setTimeout(() => showBin(chatId, adminId, null, false), 600);
    } catch (e) { console.error(e); bot.sendMessage(chatId, '❌ Error.'); }
}

// ── Broadcast flow ──
async function startBroadcast(chatId, adminId, msgId) {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    adminState[adminId] = { flow: 'broadcast', step: 'await_message' };
    bot.sendMessage(chatId,
        `📢 *Broadcast Mode*\n\nSend the message you want to broadcast to *all users*.\n` +
        `You can send: text, photo, video, audio, voice, document — anything.\n\nForward or compose your next message:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a|cancel' }]] } }
    );
}

// ── Message specific user ──
async function startMessageUser(chatId, adminId, msgId) {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    adminState[adminId] = { flow: 'msguser', step: 'await_userid' };
    bot.sendMessage(chatId,
        `👤 *Message a User*\n\nSend the *Telegram User ID* you want to message:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a|cancel' }]] } }
    );
}

// ── Create Coupon flow ──
async function startCreateCoupon(chatId, adminId, msgId) {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    adminState[adminId] = { flow: 'coupon', step: 'await_users', data: {} };
    bot.sendMessage(chatId,
        `🎟️ *Create Coupon*\n\nStep 1/3: How many *users* can claim this coupon? (e.g. 100)`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a|cancel' }]] } }
    );
}

async function showStats(chatId, adminId, msgId) {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    if (!db) return bot.sendMessage(chatId, '⚠️ Database not configured.');
    try {
        const [users, pending, approved, binned, coupons] = await Promise.all([
            db.collection('users').count().get().catch(() => ({ data: () => ({ count: '?' }) })),
            db.collection('withdrawals').where('status', '==', 'pending').count().get().catch(() => ({ data: () => ({ count: '?' }) })),
            db.collection('withdrawals').where('status', '==', 'approved').count().get().catch(() => ({ data: () => ({ count: '?' }) })),
            db.collection('withdrawals').where('status', '==', 'binned').count().get().catch(() => ({ data: () => ({ count: '?' }) })),
            db.collection('coupons').count().get().catch(() => ({ data: () => ({ count: '?' }) })),
        ]);
        bot.sendMessage(chatId,
            `📊 *Stats*\n\n` +
            `👥 Users: *${users.data().count}*\n` +
            `⏳ Pending: *${pending.data().count}*\n` +
            `✅ Approved: *${approved.data().count}*\n` +
            `🗑️ Binned: *${binned.data().count}*\n` +
            `🎟️ Coupons: *${coupons.data().count}*`,
            { parse_mode: 'Markdown', reply_markup: adminPanelKb() }
        );
    } catch (e) { bot.sendMessage(chatId, '❌ Error: ' + e.message, { reply_markup: adminPanelKb() }); }
}

// ─────────────────────────────────────────────────────────────────
// Admin flow message handler
// ─────────────────────────────────────────────────────────────────
async function handleAdminFlow(msg) {
    const chatId = msg.chat.id;
    const adminId = String(msg.from.id);
    const state = adminState[adminId];
    const text = msg.text || '';
    if (!state) return;

    // Reject reason
    if (state.flow === 'reject' && state.step === 'await_reason') {
        if (!text.trim()) return bot.sendMessage(chatId, '❌ Please enter a reason.');
        await doReject(chatId, adminId, text.trim());
        return;
    }

    // Broadcast
    if (state.flow === 'broadcast' && state.step === 'await_message') {
        state.message = msg;  // capture full message for re-send
        state.step = 'confirm';
        // Count users
        let userCount = 0;
        try {
            const snap = await db.collection('users').where('telegramId', '!=', '').get();
            userCount = snap.size;
        } catch { userCount = 0; }
        bot.sendMessage(chatId,
            `📢 Broadcast preview captured.\n\nReady to send to *${userCount}* users with linked Telegram?\n\nTap Confirm to send:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
                { text: '✅ Confirm Send', callback_data: 'a|bcconfirm' },
                { text: '❌ Cancel', callback_data: 'a|cancel' }
            ]] } }
        );
        return;
    }

    // Message specific user — step 1: get user id
    if (state.flow === 'msguser' && state.step === 'await_userid') {
        const targetId = text.trim();
        if (!/^\d+$/.test(targetId)) return bot.sendMessage(chatId, '❌ Please send a valid numeric Telegram User ID.');
        state.targetId = targetId;
        state.step = 'await_message';
        bot.sendMessage(chatId,
            `📨 Now send the message (text/photo/video/audio/voice/document) to forward to user \`${targetId}\`:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a|cancel' }]] } }
        );
        return;
    }
    if (state.flow === 'msguser' && state.step === 'await_message') {
        try {
            await bot.copyMessage(state.targetId, chatId, msg.message_id);
            bot.sendMessage(chatId, `✅ Sent to user \`${state.targetId}\`.`, { parse_mode: 'Markdown', reply_markup: adminPanelKb() });
        } catch (e) {
            bot.sendMessage(chatId, `❌ Failed: ${e.message}`, { reply_markup: adminPanelKb() });
        }
        delete adminState[adminId];
        return;
    }

    // Coupon — step 1: users count
    if (state.flow === 'coupon' && state.step === 'await_users') {
        const n = parseInt(text.trim());
        if (isNaN(n) || n <= 0) return bot.sendMessage(chatId, '❌ Send a positive number.');
        state.data.totalUses = n;
        state.step = 'await_coins';
        bot.sendMessage(chatId,
            `🎟️ Step 2/3: How many *coins* per user? (e.g. 50)`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a|cancel' }]] } }
        );
        return;
    }
    if (state.flow === 'coupon' && state.step === 'await_coins') {
        const n = parseInt(text.trim());
        if (isNaN(n) || n <= 0) return bot.sendMessage(chatId, '❌ Send a positive number.');
        state.data.coinsPerUser = n;
        state.step = 'await_code';
        bot.sendMessage(chatId,
            `🎟️ Step 3/3: Enter the *coupon code* (or send "auto" for a random code):`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'a|cancel' }]] } }
        );
        return;
    }
    if (state.flow === 'coupon' && state.step === 'await_code') {
        let code = text.trim().toUpperCase();
        if (code === 'AUTO' || !code) code = randomCode(8);
        state.data.code = code;
        state.step = 'confirm';
        bot.sendMessage(chatId,
            `🎟️ *Confirm Coupon*\n\nCode: *${code}*\nUses: *${state.data.totalUses}*\nCoins per user: *${state.data.coinsPerUser}*\n\nCreate?`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
                { text: '✅ Confirm', callback_data: 'a|cpconfirm' },
                { text: '❌ Cancel', callback_data: 'a|cancel' }
            ]] } }
        );
        return;
    }
}

async function doBroadcast(chatId, adminId) {
    const state = adminState[adminId];
    if (!state || !state.message) return;
    const sourceMsg = state.message;
    delete adminState[adminId];

    if (!db) return bot.sendMessage(chatId, '⚠️ Database not configured.', { reply_markup: adminPanelKb() });
    bot.sendMessage(chatId, `📤 Broadcasting...`);

    let sent = 0, failed = 0;
    try {
        const snap = await db.collection('users').get();
        const tids = snap.docs.map(d => d.data().telegramId).filter(Boolean);
        for (const tid of tids) {
            try {
                await bot.copyMessage(tid, sourceMsg.chat.id, sourceMsg.message_id);
                sent++;
                // small delay to avoid rate limits
                await new Promise(r => setTimeout(r, 50));
            } catch { failed++; }
        }
        bot.sendMessage(chatId, `✅ Broadcast done.\nSent: *${sent}* | Failed: *${failed}*`, { parse_mode: 'Markdown', reply_markup: adminPanelKb() });
    } catch (e) {
        bot.sendMessage(chatId, '❌ Error: ' + e.message, { reply_markup: adminPanelKb() });
    }
}

async function doCreateCoupon(chatId, adminId) {
    const state = adminState[adminId];
    if (!state) return;
    const d = state.data;
    delete adminState[adminId];

    try {
        await db.collection('coupons').add({
            code: d.code,
            totalUses: d.totalUses,
            coinsPerUser: d.coinsPerUser,
            usedCount: 0,
            usedBy: [],
            createdAt: FieldValue.serverTimestamp(),
            createdBy: adminId
        });
        bot.sendMessage(chatId,
            `✅ *Coupon Created!*\n\nCode: *${d.code}*\nUses: *${d.totalUses}*\nCoins each: *${d.coinsPerUser}*\n\nShare the code with users — they can claim from the bot menu.`,
            { parse_mode: 'Markdown', reply_markup: adminPanelKb() }
        );
    } catch (e) {
        bot.sendMessage(chatId, '❌ Error: ' + e.message, { reply_markup: adminPanelKb() });
    }
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function safeEdit(chatId, msgId, text, markup) {
    return bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: markup, disable_web_page_preview: true
    }).catch(() => {
        // If can't edit (e.g. it was a photo), send fresh message
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup, disable_web_page_preview: true }).catch(() => {});
    });
}

function promptLinkAccount(chatId, msgId) {
    const text = `⚠️ Account not linked yet.\n\nOpen the app first → Sign up / Log in → Then come back.`;
    const markup = {
        inline_keyboard: [
            [{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }],
            [{ text: '← Back to Menu', callback_data: 'u|menu' }]
        ]
    };
    if (msgId) safeEdit(chatId, msgId, text, markup);
    else bot.sendMessage(chatId, text, { reply_markup: markup });
}

async function getUserByTgId(telegramId) {
    if (!db) return null;
    const snap = await db.collection('users').where('telegramId', '==', telegramId).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function getAppConfig() {
    try {
        const snap = await db.collection('config').doc('main').get();
        const d = snap.exists ? snap.data() : {};
        return {
            minWithdrawal:     d.minWithdrawal    || 5000,
            coinValueCoins:    d.coinValueCoins   || 1000,
            coinValueInr:      d.coinValueInr     || 10,
            paymentMethods:    d.paymentMethods   || [],
            withdrawalOptions: (d.withdrawalOptions || []).map(Number).sort((a, b) => a - b),
            channelLink:       d.channelLink      || '',
            helpLink:          d.helpLink         || '',
            policyText:        d.policyText       || '',
        };
    } catch {
        return { minWithdrawal: 5000, coinValueCoins: 1000, coinValueInr: 10, paymentMethods: [], withdrawalOptions: [], channelLink: '', helpLink: '', policyText: '' };
    }
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? require('https') : require('http');
        const file = fs.createWriteStream(dest);
        proto.get(url, res => {
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    });
}

function randomCode(len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

// ─────────────────────────────────────────────────────────────────
// Public API for server.js (broadcast, sendToUser, createCoupon)
// ─────────────────────────────────────────────────────────────────
module.exports = {
    enabled: true,
    uploadDir: UPLOAD_DIR,

    /** Send a plain-text message to a Telegram chat ID */
    async sendMessage(chatId, text, opts = {}) {
        try { return await bot.sendMessage(chatId, text, opts); }
        catch (e) { console.error('sendMessage error:', e.message); return null; }
    },

    /** Broadcast a plain text message to all users with a linked telegramId */
    async broadcastToAll(text, opts = {}) {
        if (!db) return { sent: 0, failed: 0 };
        const snap = await db.collection('users').get();
        let sent = 0, failed = 0;
        for (const d of snap.docs) {
            const tid = d.data().telegramId;
            if (!tid) continue;
            try { await bot.sendMessage(tid, text, opts); sent++; await new Promise(r => setTimeout(r, 50)); }
            catch { failed++; }
        }
        return { sent, failed };
    },

    /** Notify all admin IDs */
    async notifyAdmins(text, opts = {}) {
        for (const id of ADMIN_IDS) {
            try { await bot.sendMessage(id, text, opts); } catch {}
        }
    }
};

console.log('🤖 RN Coin Hunt Bot started (in-process with main server)');
