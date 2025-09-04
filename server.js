// server.js — wa-bot (Express + whatsapp-web.js) — Render friendly + RemoteAuth

const express = require('express');
const fs = require('fs/promises');
const QRCode = require('qrcode');
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');

// Optional deps for RemoteAuth (fallback إلى LocalAuth إذا ماكانوش)
let mongoose = null, MongoStore = null;
try {
  mongoose = require('mongoose');
  ({ MongoStore } = require('wwebjs-mongo'));
} catch (_) { /* ok */ }

const app = express();
app.use(express.json());

// ===== Config =====
const PORT       = process.env.PORT || 10000;
const API_KEY    = process.env.API_KEY || 'change-me';
const DATA_PATH  = process.env.WWEBJS_DATA  || '/var/data/wwebjs';
const CACHE_PATH = process.env.WWEBJS_CACHE || '/var/data/wwebjs-cache';
const MONGO_URI  = process.env.MONGO_URI || null;   // استعمل URL-encoded password إذا فيه رموز خاصة
const MONGO_DB   = process.env.MONGO_DB  || 'wa-bot';

// ===== Open/Protected routes =====
const isOpenPath = (p) =>
  p === '/' || p.startsWith('/health') || p.startsWith('/healthz') ||
  p.startsWith('/ready') || p.startsWith('/qr') || p.startsWith('/debug');

// Security: x-api-key لكل المسارات المحمية
app.use((req, res, next) => {
  if (isOpenPath(req.path || '/')) return next();
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).json({ ok:false, error:'Unauthorized' });
  next();
});

// ===== WA State =====
let client;
let lastQr = null;
let isAuthenticated = false;
let isReady = false;
const lastEvents = [];
const pushEv = (ev) => {
  lastEvents.push({ ev, ts: new Date().toISOString() });
  if (lastEvents.length > 100) lastEvents.shift();
};

// ===== Routes (open) =====
app.get('/', (_req, res) => res.json({ ok:true, service:'wa-bot' }));
app.get('/health', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime() }));
app.get('/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime() }));

app.get('/ready', (_req, res) => {
  if (isReady) return res.json({ ok:true });
  res.status(503).json({
    ok:false, error:'not_ready',
    hint:'Open /qr, scan the WhatsApp QR code, then wait for chats to finish loading.'
  });
});

app.get('/qr', async (_req, res) => {
  try {
    if (isReady || isAuthenticated) {
      return res.send(`<html><body style="font-family:sans-serif">
        <h2>Already authenticated ✅</h2><p>You can close this page.</p>
      </body></html>`);
    }
    if (!lastQr) {
      return res.send(`<html><body style="font-family:sans-serif">
        <h2>QR not generated yet…</h2><p>Keep this page open and refresh in a few seconds.</p>
      </body></html>`);
    }
    const dataUrl = await QRCode.toDataURL(lastQr);
    res.send(`<html><body style="font-family:sans-serif;text-align:center">
      <h2>Scan this QR with WhatsApp</h2>
      <img src="${dataUrl}" alt="QR" style="width:320px;height:320px"/>
      <p>If it expires, refresh the page.</p>
    </body></html>`);
  } catch (e) {
    console.error('QR error:', e);
    res.status(500).send('QR error');
  }
});

app.get('/debug', (_req, res) => {
  res.json({ ok:true, isAuthenticated, isReady, events:lastEvents.slice(-20) });
});

// ===== Helpers =====
const asyncHandler = (fn)=> (req,res,next)=> Promise.resolve(fn(req,res,next)).catch(next);

// Protected APIs
app.get('/me', asyncHandler(async (_req, res) => {
  if (!isReady) return res.status(503).json({ ok:false, error:'not_ready' });
  const info = client.info || null;
  res.json({
    ok:true,
    me: info ? { pushname: info.pushname, wid: info.wid?._serialized ?? null, platform: info.platform } : null
  });
}));

app.get('/groups', asyncHandler(async (_req, res) => {
  if (!isReady) return res.status(503).json({ ok:false, error:'not_ready', hint:'Scan /qr then retry.' });
  const chats = await client.getChats();
  const groups = chats.filter(c=>c.isGroup).map(g=>({
    id: g.id?._serialized, name: g.name, participantsCount: g.participants?.length ?? null
  }));
  res.json({ ok:true, count: groups.length, groups });
}));

// { "to": "2126xxxxxxx@c.us" | "xxxxxx@g.us", "message": "Hi" }
app.post('/send', asyncHandler(async (req, res) => {
  if (!isReady) return res.status(503).json({ ok:false, error:'not_ready' });
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ ok:false, error:'to_and_message_required' });
  await client.sendMessage(to, message);
  res.json({ ok:true });
}));

// Optional: soft reload (destroy & re-init) — محمي بالـ API KEY
app.post('/reload', asyncHandler(async (_req, res) => {
  try {
    if (client) await client.destroy().catch(()=>{});
    lastQr = null; isReady = false; isAuthenticated = false;
    await initWithRetry();
    res.json({ ok:true, msg:'client reloaded' });
  } catch (e) {
    res.status(500).json({ ok:false, error:'reload_failed', detail:String(e) });
  }
}));

// Error handler
app.use((err,_req,res,_next)=>{
  console.error('Unhandled error:', err);
  res.status(500).json({ ok:false, error:'server_error', detail:String(err.message||err) });
});

// ===== WhatsApp init =====
async function initWhatsApp() {
  await fs.mkdir(DATA_PATH,  { recursive:true });
  await fs.mkdir(CACHE_PATH, { recursive:true });

  const useRemote = !!(MONGO_URI && mongoose && MongoStore);
  let authStrategy;

  if (useRemote) {
    await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });
    const store = new MongoStore({ mongoose });
    authStrategy = new RemoteAuth({ store, backupSyncIntervalMs: 300000 });
    console.log('[Auth] Using RemoteAuth (Mongo).');
  } else {
    authStrategy = new LocalAuth({ dataPath: DATA_PATH });
    console.log('[Auth] Using LocalAuth at', DATA_PATH);
  }

  client = new Client({
    authStrategy,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    restartOnAuthFail: true,
    qrMaxRetries: 6,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--single-process',
        '--no-zygote',
        '--disable-gpu',
        '--js-flags=--max-old-space-size=256'
      ],
      protocolTimeout: 60000
    },
    // استخدام cache عن بُعد لنسخة WhatsApp Web (أكثر استقراراً)
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/webCache.json'
    }
  });

  client.on('qr', (qr) => { lastQr = qr; isAuthenticated = false; isReady = false; pushEv('qr'); console.log('[QR] new QR generated'); });
  client.on('authenticated', () => { isAuthenticated = true; pushEv('authenticated'); console.log('Authenticated 🔐'); });
  client.on('ready', () => { isReady = true; pushEv('ready'); console.log('WhatsApp ready ✅'); });
  client.on('loading_screen', (p, msg) => console.log('Loading…', p, msg));
  client.on('change_state', (s) => console.log('[State]', s));
  client.on('disconnected', (reason) => { isReady = false; pushEv(`disconnected:${reason}`); console.warn('[Disconnected]', reason); });

  await client.initialize();
}

// Retry wrapper (يحاول يعاود init إذا تزلق Puppeteer)
async function initWithRetry(retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      await initWhatsApp();
      return;
    } catch (e) {
      console.error(`[init] failed (${i}/${retries}):`, e.message || e);
      await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
  // إذا فشل كلشي، خرج باش Render يعاود يشغل الخدمة
  process.exit(1);
}

// ===== Start server =====
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

initWithRetry();

// Guards
process.on('unhandledRejection', (r)=>console.error('unhandledRejection', r));
process.on('uncaughtException', (e)=>console.error('uncaughtException', e));
