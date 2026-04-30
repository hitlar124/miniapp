const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
