const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ── Admin credentials file (set via setup, verified for API calls) ──
const ADMIN_CREDS_FILE  = path.join(__dirname, '.admin_creds.json');
const ADMIN_CONFIG_FILE = path.join(__dirname, '.admin_config.json');

function loadAdminCreds() {
    try { return JSON.parse(fs.readFileSync(ADMIN_CREDS_FILE, 'utf8')); } catch { return null; }
}
function saveAdminCreds(u, p) {
    fs.writeFileSync(ADMIN_CREDS_FILE, JSON.stringify({ u, p }), 'utf8');
}
function verifyAdminCreds(u, p) {
    const c = loadAdminCreds();
    return c && c.u === u && c.p === p;
}
function loadAdminConfig() {
    try { return JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveAdminConfig(cfg) {
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cfg), 'utf8');
}

// ── Check if server has been set up (safe, no secrets exposed) ──
app.get('/api/admin/has-config', (req, res) => {
    const c = loadAdminCreds();
    res.json({ setup: !!(c && c.u && c.p) });
});

// ── Save admin credentials (called from setup step 1) ──
app.post('/api/admin/save-creds', (req, res) => {
    const { u, p } = req.body || {};
    if (!u || !p) return res.status(400).json({ ok: false, error: 'Missing credentials' });
    saveAdminCreds(u, p);
    res.json({ ok: true });
});

// ── Get full panel config (firebase, adminUids, etc.) ──
app.post('/api/admin/get-config', (req, res) => {
    const { u, p } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    const cfg = loadAdminConfig();
    res.json({ ok: true, config: cfg });
});

// ── Save full panel config (firebase, adminUids, etc.) ──
app.post('/api/admin/save-full-config', (req, res) => {
    const { u, p, config } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!config || typeof config !== 'object') return res.status(400).json({ ok: false, error: 'config required' });
    saveAdminConfig(config);
    res.json({ ok: true });
});

// ── Clear panel config (called on reset) ──
app.post('/api/admin/clear-config', (req, res) => {
    const { u, p } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    try { fs.unlinkSync(ADMIN_CREDS_FILE); } catch {}
    try { fs.unlinkSync(ADMIN_CONFIG_FILE); } catch {}
    res.json({ ok: true });
});

// ── Resolve a user input (email or Firestore UID) to a Firestore doc ID ──
async function resolveUserId(botDb, input) {
    if (!input) return null;
    if (input.includes('@')) {
        const snap = await botDb.collection('users').where('email', '==', input.toLowerCase().trim()).limit(1).get();
        if (snap.empty) return null;
        return snap.docs[0].id;
    }
    return input.trim();
}

// ── Adjust a user's coin balance (firebase-admin, bypasses Firestore auth) ──
app.post('/api/admin/adjust-coins', async (req, res) => {
    const { u, p, userId, delta, reason } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!userId || delta === undefined) return res.status(400).json({ ok: false, error: 'userId and delta required' });
    try {
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const { FieldValue } = require('firebase-admin/firestore');
        const resolvedId = await resolveUserId(botDb, userId);
        if (!resolvedId) return res.status(404).json({ ok: false, error: 'No user found with that email or ID' });
        const ref = botDb.collection('users').doc(resolvedId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        await ref.update({ balance: FieldValue.increment(Number(delta)) });
        const newBalance = (snap.data().balance || 0) + Number(delta);
        res.json({ ok: true, newBalance, name: snap.data().name || resolvedId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Ban / unban a user by ID or email ──
app.post('/api/admin/ban-user', async (req, res) => {
    const { u, p, userId, banned } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    try {
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const resolvedId = await resolveUserId(botDb, userId);
        if (!resolvedId) return res.status(404).json({ ok: false, error: 'No user found with that email or ID' });
        const ref = botDb.collection('users').doc(resolvedId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'User not found' });
        await ref.update({ isBlocked: !!banned });
        res.json({ ok: true, name: snap.data().name || resolvedId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Broadcast notification via firebase-admin (bypasses Firestore auth rules) ──
app.post('/api/admin/broadcast', async (req, res) => {
    const { u, p, title, message } = req.body || {};
    if (!verifyAdminCreds(u, p)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    if (!title || !message) return res.status(400).json({ ok: false, error: 'Title and message required' });
    try {
        // Use the bot's firebase-admin db (same process)
        let botDb = null;
        try { botDb = require('firebase-admin/firestore').getFirestore(); } catch {}
        if (!botDb) return res.status(503).json({ ok: false, error: 'Firebase not configured on server' });
        const { FieldValue } = require('firebase-admin/firestore');
        await botDb.collection('notifications').add({ title, message, createdAt: FieldValue.serverTimestamp() });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Config endpoint — reads from Render environment variables
// User-app loads this to get Firebase config without hardcoding
app.get('/config.js', (req, res) => {
    res.type('application/javascript');
    res.send(`window.APP_CONFIG = ${JSON.stringify({
        firebase: {
            apiKey:            process.env.FIREBASE_API_KEY            || '',
            authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || '',
            projectId:         process.env.FIREBASE_PROJECT_ID         || '',
            storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || '',
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
            appId:             process.env.FIREBASE_APP_ID             || ''
        },
        botUsername: process.env.BOT_USERNAME  || '',
        miniAppUrl:  process.env.MINI_APP_URL  || '',
        serverUrl:   process.env.SERVER_URL    || ''
    })};`);
});

// Static file serving
app.use('/user-app',    express.static(path.join(__dirname, 'user-app')));
app.use('/admin-panel', express.static(path.join(__dirname, 'admin-panel')));
app.use('/uploads',     express.static(path.join(__dirname, 'bot', 'uploads')));

// Root page
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>RN Coin Hunt</title>
    <style>
        body { font-family: sans-serif; background: #09090f; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 1rem; margin: 0; }
        a { color: #f59e0b; font-size: 1.1rem; text-decoration: none; padding: 0.6rem 1.5rem; border: 1px solid #f59e0b44; border-radius: 0.5rem; transition: background 0.2s; }
        a:hover { background: #f59e0b22; }
    </style>
</head>
<body>
    <span style="font-size:3rem">🪙</span>
    <h2 style="margin:0">RN Coin Hunt</h2>
    <a href="/user-app/">Open User App</a>
    <a href="/admin-panel/">Open Admin Panel</a>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log(`RN Coin Hunt server running on port ${PORT}`);

    // Start the Telegram bot in the same process.
    // It uses long-polling, so it doesn't need its own port.
    // Main server traffic keeps the whole process awake on Render free tier.
    try {
        require('./bot/bot.js');
    } catch (e) {
        console.error('Failed to start bot:', e.message);
    }
});
