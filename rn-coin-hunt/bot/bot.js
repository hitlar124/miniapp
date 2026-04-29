const TelegramBot = require('node-telegram-bot-api');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const multer = require('multer');
const express = require('express');
const path = require('path');
const fs = require('fs');

// ============================================================
// CONFIG — Fill these in
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || '1414414216,7728185213').split(',').map(s => s.trim());
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-render-app.onrender.com/user-app/';
const PORT = process.env.PORT || 3000;

// ============================================================
// Firebase Admin Init
// ============================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Upload directory for QR codes
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- Withdrawal flow state ----
const withdrawalState = {}; // userId -> { step, data }

// ============================================================
// /start command — Show main menu
// ============================================================
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const startParam = (match[1] || '').trim().replace(/^\//, '');

    // Store telegram ID if user exists in Firestore
    try {
        const q = await db.collection('users').where('telegramId', '==', userId).get();
        if (q.empty) {
            // Try to link by email if they have an account
        }
    } catch (e) { console.error(e); }

    const opts = {
        reply_markup: {
            keyboard: [
                [{ text: '🪙 Open App', web_app: { url: startParam ? `${MINI_APP_URL}?start=${startParam}` : MINI_APP_URL } }],
                [{ text: '💰 Balance & Withdraw' }],
                [{ text: '📊 My Stats' }, { text: '🆘 Help' }]
            ],
            resize_keyboard: true
        }
    };
    bot.sendMessage(chatId, `👋 Welcome to *RN Coin Hunt*!\n\nComplete tasks, earn coins, and withdraw your rewards.\n\nTap *Open App* to start earning! 🚀`, { parse_mode: 'Markdown', ...opts });
});

// ============================================================
// Balance & Withdraw button
// ============================================================
bot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    // Handle withdrawal flow steps
    if (withdrawalState[userId]) {
        await handleWithdrawalFlow(msg);
        return;
    }

    if (text === '💰 Balance & Withdraw') {
        await showBalancePage(chatId, userId);
    } else if (text === '📊 My Stats') {
        await showStats(chatId, userId);
    } else if (text === '🆘 Help') {
        showHelp(chatId);
    }
});

async function showBalancePage(chatId, telegramId) {
    try {
        const user = await getUserByTelegramId(telegramId);
        if (!user) {
            bot.sendMessage(chatId, '⚠️ Account not linked yet.\n\nPlease open the app first and make sure you are logged in.', {
                reply_markup: { keyboard: [[{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }]], resize_keyboard: true }
            });
            return;
        }

        const configSnap = await db.collection('config').doc('main').get();
        const config = configSnap.exists ? configSnap.data() : {};
        const minWithdrawal = config.minWithdrawal || 5000;
        const methods = config.paymentMethods || [];
        const coinValueCoins = config.coinValueCoins || 1000;
        const coinValueInr = config.coinValueInr || 10;

        const bal = user.balance || 0;
        const inrValue = bal >= coinValueCoins ? Math.floor(bal / coinValueCoins) * coinValueInr : 0;

        const canWithdraw = bal >= minWithdrawal;

        let methodButtons = [];
        if (canWithdraw && methods.length > 0) {
            methodButtons = methods.map(m => [{ text: `💳 Withdraw via ${m}` }]);
        }

        bot.sendMessage(chatId,
            `💰 *Your Wallet*\n\n` +
            `🪙 Coins: *${bal}*\n` +
            `₹ Value: *₹${inrValue}*\n` +
            `📉 Rate: ${coinValueCoins} Coins = ₹${coinValueInr}\n\n` +
            `${canWithdraw ? `✅ You can withdraw! Min: ${minWithdrawal} Coins\n\nChoose a payment method:` : `❌ Min withdrawal: ${minWithdrawal} Coins\nNeed ${minWithdrawal - bal} more coins.`}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [
                        ...methodButtons,
                        [{ text: '🔙 Back to Menu' }]
                    ],
                    resize_keyboard: true
                }
            }
        );
    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, 'Error loading balance. Please try again.');
    }
}

// ---- Withdrawal method selected ----
bot.on('message', async (msg) => {
    if (!msg.text || withdrawalState[msg.from.id.toString()]) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    if (text.startsWith('💳 Withdraw via ')) {
        const method = text.replace('💳 Withdraw via ', '').trim();
        withdrawalState[userId] = { step: 'ask_amount', data: { method } };
        bot.sendMessage(chatId, `You selected *${method}*.\n\nPlease enter the *coin amount* you want to withdraw:`, {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [[{ text: '❌ Cancel' }]], resize_keyboard: true }
        });
    } else if (text === '🔙 Back to Menu') {
        sendMainMenu(chatId, userId);
    }
});

async function handleWithdrawalFlow(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text || '';
    const photo = msg.photo;
    const state = withdrawalState[userId];
    if (!state) return;

    if (text === '❌ Cancel') {
        delete withdrawalState[userId];
        bot.sendMessage(chatId, 'Withdrawal cancelled.', { reply_markup: { remove_keyboard: true } });
        setTimeout(() => sendMainMenu(chatId, userId), 500);
        return;
    }

    if (state.step === 'ask_amount') {
        const amount = parseInt(text);
        const user = await getUserByTelegramId(userId);
        const configSnap = await db.collection('config').doc('main').get();
        const config = configSnap.exists ? configSnap.data() : {};
        const minWithdrawal = config.minWithdrawal || 5000;

        if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, '❌ Please enter a valid number.'); return; }
        if (!user || amount > user.balance) { bot.sendMessage(chatId, '❌ Insufficient coins.'); return; }
        if (amount < minWithdrawal) { bot.sendMessage(chatId, `❌ Minimum withdrawal is ${minWithdrawal} coins.`); return; }

        state.data.amount = amount;
        state.step = 'ask_account_name';
        bot.sendMessage(chatId, `✅ Amount: *${amount} Coins*\n\nPlease enter your *account holder name*:`, { parse_mode: 'Markdown' });
    }
    else if (state.step === 'ask_account_name') {
        state.data.accountName = text.trim();
        state.step = 'ask_qr';
        bot.sendMessage(chatId, `✅ Name: *${state.data.accountName}*\n\nNow please upload your *QR Code* image for payment:`, { parse_mode: 'Markdown' });
    }
    else if (state.step === 'ask_qr') {
        if (!photo) { bot.sendMessage(chatId, '📸 Please upload a QR code image (as a photo).'); return; }
        try {
            // Download the QR image from Telegram
            const fileId = photo[photo.length - 1].file_id;
            const fileUrl = await bot.getFileLink(fileId);
            const https = require('https');
            const http = require('http');
            const fname = `qr_${userId}_${Date.now()}.jpg`;
            const fpath = path.join(UPLOAD_DIR, fname);
            await downloadFile(fileUrl, fpath);

            // Use static server URL — adjust to your domain
            const qrCodeUrl = `${process.env.SERVER_URL || 'https://your-render-app.onrender.com'}/uploads/${fname}`;
            state.data.qrCodeUrl = qrCodeUrl;
            state.data.qrLocalPath = fpath;
            state.step = 'confirm';

            bot.sendMessage(chatId,
                `📋 *Withdrawal Summary*\n\n` +
                `💳 Method: *${state.data.method}*\n` +
                `🪙 Amount: *${state.data.amount} Coins*\n` +
                `👤 Name: *${state.data.accountName}*\n` +
                `📷 QR: Uploaded ✅\n\n` +
                `Submit this request?`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [[{ text: '✅ Confirm & Submit' }, { text: '❌ Cancel' }]],
                        resize_keyboard: true
                    }
                }
            );
        } catch (e) { console.error(e); bot.sendMessage(chatId, 'Error uploading QR. Try again.'); }
    }
    else if (state.step === 'confirm') {
        if (text !== '✅ Confirm & Submit') { bot.sendMessage(chatId, 'Please tap Confirm or Cancel.'); return; }
        try {
            const user = await getUserByTelegramId(userId);
            if (!user) { bot.sendMessage(chatId, 'Account not found.'); delete withdrawalState[userId]; return; }

            // Deduct coins
            await db.collection('users').doc(user.id).update({ balance: FieldValue.increment(-state.data.amount) });

            // Save withdrawal request
            await db.collection('withdrawals').add({
                userId: user.id,
                userName: user.name,
                userEmail: user.email,
                telegramId: userId,
                amount: state.data.amount,
                method: state.data.method,
                accountName: state.data.accountName,
                qrCodeUrl: state.data.qrCodeUrl,
                status: 'pending',
                requestedAt: FieldValue.serverTimestamp()
            });

            // Notify admins on Telegram
            const adminMsg = `🔔 *New Withdrawal Request!*\n\n` +
                `👤 User: ${user.name}\n` +
                `📧 Email: ${user.email}\n` +
                `💳 Method: ${state.data.method}\n` +
                `🪙 Amount: ${state.data.amount} Coins\n` +
                `👤 Account: ${state.data.accountName}\n\n` +
                `📷 QR Code attached above.\n` +
                `Please check the Admin Panel to approve or reject.`;

            for (const adminId of ADMIN_TELEGRAM_IDS) {
                try {
                    // Send QR image to admin
                    await bot.sendPhoto(adminId, state.data.qrLocalPath, { caption: adminMsg, parse_mode: 'Markdown' });
                } catch (e2) { console.error('Failed to notify admin:', e2.message); }
            }

            delete withdrawalState[userId];
            bot.sendMessage(chatId, `✅ *Request Submitted!*\n\nYour withdrawal of *${state.data.amount} coins* via *${state.data.method}* has been submitted.\n\nWe will process it within 24-48 hours. You will be notified here.`, {
                parse_mode: 'Markdown',
                reply_markup: { keyboard: [[{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }], [{ text: '💰 Balance & Withdraw' }]], resize_keyboard: true }
            });
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, 'Error submitting. Please try again.');
        }
    }
}

async function showStats(chatId, telegramId) {
    try {
        const user = await getUserByTelegramId(telegramId);
        if (!user) { bot.sendMessage(chatId, '⚠️ Open the app first to link your account.'); return; }
        const withdrawSnap = await db.collection('withdrawals').where('userId', '==', user.id).get();
        const total = withdrawSnap.docs.reduce((s, d) => s + (d.data().status === 'approved' ? d.data().amount : 0), 0);
        bot.sendMessage(chatId,
            `📊 *Your Stats*\n\n` +
            `👤 Name: ${user.name}\n` +
            `🪙 Balance: ${user.balance || 0} Coins\n` +
            `✅ Total Approved: ${total} Coins\n` +
            `📋 Total Requests: ${withdrawSnap.size}`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) { bot.sendMessage(chatId, 'Error loading stats.'); }
}

function showHelp(chatId) {
    bot.sendMessage(chatId,
        `🆘 *Help*\n\n` +
        `🪙 *Earn Coins:*\n` +
        `• Daily Check-in\n• Watch Video Ads\n• Solve Math Quizzes\n• Refer Friends\n\n` +
        `💰 *Withdraw:*\n` +
        `Tap "Balance & Withdraw" to submit a withdrawal request.\n\n` +
        `📱 *Open App:*\n` +
        `Use the Open App button to access the full mini app.`,
        { parse_mode: 'Markdown' }
    );
}

function sendMainMenu(chatId, userId) {
    bot.sendMessage(chatId, '🏠 Main Menu', {
        reply_markup: {
            keyboard: [
                [{ text: '🪙 Open App', web_app: { url: MINI_APP_URL } }],
                [{ text: '💰 Balance & Withdraw' }],
                [{ text: '📊 My Stats' }, { text: '🆘 Help' }]
            ],
            resize_keyboard: true
        }
    });
}

async function getUserByTelegramId(telegramId) {
    const q = await db.collection('users').where('telegramId', '==', telegramId).get();
    if (!q.empty) { return { id: q.docs[0].id, ...q.docs[0].data() }; }
    return null;
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? require('https') : require('http');
        const file = fs.createWriteStream(dest);
        proto.get(url, (res) => { res.pipe(file); file.on('finish', () => { file.close(resolve); }); })
            .on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    });
}

// ============================================================
// Express server — serves uploaded QR files
// ============================================================
const expressApp = express();
expressApp.use('/uploads', express.static(UPLOAD_DIR));
expressApp.get('/', (req, res) => res.send('RN Coin Hunt Bot is running!'));
expressApp.listen(PORT, () => console.log(`Server running on port ${PORT}`));

console.log('🤖 RN Coin Hunt Bot started!');
