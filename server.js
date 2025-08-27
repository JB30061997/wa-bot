// server.js — final
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');

// Optional (for RemoteAuth)
let mongoose = null, MongoStore = null;
try {
  mongoose = require('mongoose');
  ({ MongoStore } = require('wwebjs-mongo'));
} catch (_) { /* ok if not installed */ }

const app = express();
app.use(express.json());

// ===== Security (API KEY) =====
const API_KEY = process.env.API_KEY || 'change-me';
app.use((req, res, next) => {
  // افتوحين بلا مفتاح باش تشوف الصحة والـ QR
  if (req.path === '/health' || req.path === '/qr' || req.path === '/') return next();
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ===== Health & Root =====
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'wa-bot' }));

// ===== WhatsApp Client Setup =====
let client;            // will be assigned after auth strategy chosen
let isReady = false;   // becomes true on 'ready'
let lastQR = null;     // latest QR raw string for /qr page

async function buildClient() {
  const useRemote = !!(process.env.MONGO_URI && mongoose && MongoStore);
  let authStrategy;

  if (useRemote) {
    // RemoteAuth (Mongo) — لا تحتاج Disk
    await mongoose.connect(process.env.MONGO_URI, { dbName: 'wa-bot' });
    const store = new MongoStore({ mongoose });
    authStrategy = new RemoteAuth({
      store,
      backupSyncIntervalMs: 300000, // 5 min
    });
    console.log('[Auth] Using RemoteAuth (Mongo).');
  } else {
    // LocalAuth — يفضَّل Disk على .wwebjs_auth فـ Render
    authStrategy = new LocalAuth({ dataPath: '.wwebjs_auth' });
    console.log('[Auth] Using LocalAuth (.wwebjs_auth).');
  }

  client = new Client({
    authStrategy,
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    },
    // يحسّن التوافق مع نسخ WhatsApp Web
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/webCache.json'
    }
  });

  // ---- Events
  client.on('qr', (qr) => {
    lastQR = qr;
    console.log('=== Scan this QR with WhatsApp (Linked Devices) ===');
    try { qrcodeTerminal.generate(qr, { small: true }); } catch (_) {}
  });
  client.on('authenticated', () => console.log('Authenticated 🔐'));
  client.on('auth_failure', (m) => console.error('AUTH FAILURE ❌', m));
  client.on('loading_screen', (p, msg) => console.log('Loading…', p, msg));
  client.on('change_state', (s) => console.log('State changed →', s));
  client.on('ready', () => { isReady = true; console.log('WhatsApp ready ✅'); });
  client.on('disconnected', (reason) => {
    isReady = false;
    console.warn('WhatsApp disconnected:', reason);
  });

  await client.initialize();
}

buildClient().catch((e) => {
  console.error('Client init error:', e);
  process.exit(1);
});

// ===== QR page (image) =====
app.get('/qr', async (_req, res) => {
  if (!lastQR) return res.status(404).send('No QR yet. Refresh after a few seconds.');
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
    console.error('QR render error:', e);
    res.status(500).send('Failed to render QR');
  }
});

// ===== Helper: ensure READY =====
function ensureReady(res) {
  if (!isReady) {
    res.status(503).json({
      ok: false,
      error: 'not_ready',
      hint: 'Open /qr, scan the WhatsApp QR code, then retry after chats finish loading.'
    });
    return false;
  }
  return true;
}

// ===== Status (diagnostic) =====
app.get('/status', async (_req, res) => {
  let state = null, groups = null, err = null;
  try {
    if (client) state = await client.getState().catch(() => null); // CONNECTED / DISCONNECTED / null
    if (state === 'CONNECTED' && isReady) {
      const chats = await client.getChats().catch(() => null);
      if (chats) groups = chats.filter(c => c.isGroup).length;
    }
  } catch (e) { err = e.message || String(e); }
  res.json({ ok: state === 'CONNECTED' && isReady, state, ready: isReady, groups_count: groups, error: err });
});

// ===== List groups =====
app.get('/groups', async (_req, res) => {
  if (!ensureReady(res)) return;
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup).map(g => g.name);
    res.json({ ok: true, groups });
  } catch (e) {
    console.error('GET /groups transient error:', e);
    // غالباً مازال كيـload الدردشات
    res.status(503).json({ ok: false, error: 'not_ready', hint: 'WhatsApp is still loading chats; retry in a few seconds.' });
  }
});

// ===== Send message to group =====
app.post('/send', async (req, res) => {
  if (!ensureReady(res)) return;

  const { group, text } = req.body || {};
  if (!group || !text) return res.status(400).json({ ok: false, error: 'group & text required' });

  try {
    const chats = await client.getChats();
    const grp = chats.find(c => c.isGroup && c.name.toLowerCase() === group.toLowerCase());
    if (!grp) return res.status(404).json({ ok: false, error: `Group "${group}" not found` });

    await client.sendMessage(grp.id._serialized, text);
    res.json({ ok: true, message: 'sent' });
  } catch (e) {
    console.error('POST /send transient error:', e);
    res.status(503).json({ ok: false, error: 'not_ready', hint: 'WhatsApp is still loading chats; retry in a few seconds.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Server listening on', PORT));
