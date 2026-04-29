const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use('/user-app', express.static(path.join(__dirname, 'user-app')));
app.use('/admin-panel', express.static(path.join(__dirname, 'admin-panel')));
app.use('/uploads', express.static(path.join(__dirname, 'bot', 'uploads')));

// Root redirect
app.get('/', (req, res) => {
    res.send(`
        <html><head><title>RN Coin Hunt</title></head>
        <body style="font-family:sans-serif;background:#0a0a14;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;">
            <h1 style="font-size:3rem">🪙</h1>
            <h2>RN Coin Hunt</h2>
            <a href="/user-app/" style="color:#f59e0b">User App</a>
            <a href="/admin-panel/" style="color:#f97316">Admin Panel</a>
        </body></html>
    `);
});

app.listen(PORT, () => console.log(`RN Coin Hunt server running on port ${PORT}`));
