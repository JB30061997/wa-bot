const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
app.use(express.json());

// خلّي البوت يربط سيشن محلياً باش ماتعاودش تسكانِي كل مرة
const client = new Client({
    authStrategy: new LocalAuth(),           // كيسجل السيشن ف .wwebjs_auth
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu'
        ],
    },
});

// QR فالتيرمينال أول مرة
client.on('qr', (qr) => {
    console.log('📷 سْكاني هاد QR من تليفون الواتساب ديال البوت:');
    qrcode.generate(qr, { small: true });
});

// أحداث مفيدة
client.on('ready', () => console.log('✅ WhatsApp client جاهز'));
client.on('authenticated', () => console.log('🔐 Authenticated'));
client.on('auth_failure', (m) => console.error('❌ Auth failure:', m));
client.on('disconnected', (r) => console.warn('⚠️ Disconnected:', r));

client.initialize();

// helper: لقَى الجروب بالاسم
async function findGroupByName(name) {
    const chats = await client.getChats();
    return chats.find(c => c.isGroup && c.name.toLowerCase() === name.toLowerCase());
}

// POST /send  { "group": "Production Alerts", "text": "Hello 👋" }
app.post('/send', async (req, res) => {
    try {
        const { group, text } = req.body;
        if (!group || !text) {
            return res.status(400).json({ ok: false, error: 'group and text are required' });
        }
        const grp = await findGroupByName(group);
        if (!grp) return res.status(404).json({ ok: false, error: `Group "${group}" not found` });

        await client.sendMessage(grp.id._serialized, text);
        return res.json({ ok: true });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: 'internal error' });
    }
});

// GET /groups  → باش تشوف أسامي الجروبات
app.get('/groups', async (_req, res) => {
    try {
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup).map(g => g.name);
        res.json({ groups });
    } catch (e) {
        res.status(500).json({ ok: false });
    }
});

const PORT = process.env.PORT || 3001;
// مهم للأمان: فالبروडकشن خليه يسمع غير للـ localhost واستعمل Nginx كـ reverse proxy
app.listen(PORT, '127.0.0.1', () => console.log('HTTP API on :' + PORT));
