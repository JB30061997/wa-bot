// server.js — final minimal for Render
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// ===== Security: API key header =====
const API_KEY = process.env.API_KEY || 'change-me';
if (req.path === '/health' || req.path === '/qr') return next();

// ===== Health =====
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ===== WhatsApp Client =====
let isReady = false;
let lastQR = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }), // mount this as a Disk on Render
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', (qr) => {
  lastQR = qr;
  console.log('=== Scan this QR with WhatsApp (Linked Devices) ===');
  qrcodeTerminal.generate(qr, { small: true }); // ASCII in logs
});

client.on('ready', () => {
  isReady = true;
  console.log('WhatsApp ready ✅');
});

client.on('disconnected', (reason) => {
  isReady = false;
  console.warn('WhatsApp disconnected:', reason);
});

client.initialize();

// ===== QR page (image) =====
app.get('/qr', async (_req, res) => {
  if (!lastQR) return res.status(404).send('No QR yet. Wait for QR event (check logs) and refresh.');
  try {
    const dataUrl = await QRCode.toDataURL(lastQR);
    res.type('html').send(`
      <html><body style="display:grid;place-items:center;height:100vh;background:#0b0b0b;color:#eee">
        <div style="text-align:center;font-family:sans-serif">
          <h2>Scan with WhatsApp → Linked Devices</h2>
          <img src="${dataUrl}" width="320" height="320" />
          <p>If it expires, refresh this page.</p>
        </div>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('Failed to render QR');
  }
});

// ===== Helper: ensure ready =====
async function ensureReady(res) {
  if (isReady) return true;
  const state = await client.getState().catch(() => null);
  if (state !== 'CONNECTED') {
    return res.status(503).json({
      ok: false,
      error: 'not_ready',
      hint: 'Open /qr and scan the WhatsApp QR code, then retry.'
    });
  }
  isReady = true;
  return true;
}

// ===== API: list groups =====
app.get('/groups', async (req, res) => {
  if (!(await ensureReady(res))) return;
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup).map(g => g.name);
    res.json({ ok: true, groups });
  } catch (e) {
    console.error('GET /groups error:', e);
    res.status(500).json({ ok: false, error: e.message || 'internal_error' });
  }
});

// ===== API: send to group =====
app.post('/send', async (req, res) => {
  if (!(await ensureReady(res))) return;
  const { group, text } = req.body || {};
  if (!group || !text) return res.status(400).json({ ok: false, error: 'group & text required' });

  try {
    const chats = await client.getChats();
    const grp = chats.find(c => c.isGroup && c.name.toLowerCase() === group.toLowerCase());
    if (!grp) return res.status(404).json({ ok: false, error: `Group "${group}" not found` });

    await client.sendMessage(grp.id._serialized, text);
    res.json({ ok: true, message: 'sent' });
  } catch (e) {
    console.error('POST /send error:', e);
    res.status(500).json({ ok: false, error: e.message || 'internal_error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Server listening on', PORT));
