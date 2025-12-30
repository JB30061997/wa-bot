// server.js
// ملاحظة (Darija): الهدف هو مانخليوش init يتعاود بزاف + نديرو destroy قبل re-init

const express = require('express');
const fs = require('fs/promises');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(express.json());

const PORT    = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'change-me';

const isRender = !!process.env.RENDER;

// Darija: خزن الsession + cache فـ disk persist باش مايضيعوش
const DATA_PATH  = process.env.WWEBJS_DATA  || (isRender ? '/var/data/wwebjs' : './data/wwebjs');
const CACHE_PATH = process.env.WWEBJS_CACHE || (isRender ? '/var/data/wwebjs-cache' : './data/wwebjs-cache');

// ===== Open paths =====
const isOpenPath = (p) =>
  p === '/' ||
  p.startsWith('/health') || p.startsWith('/healthz') ||
  p.startsWith('/ready')  || p.startsWith('/qr') ||
  p.startsWith('/debug');

app.use((req, res, next) => {
  if (isOpenPath(req.path || '/')) return next();
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).json({ ok:false, error:'Unauthorized' });
  next();
});

// ===== State =====
let client = null;
let lastQr = null;
let isAuthenticated = false;
let isReady = false;

const lastEvents = [];
const pushEv = (ev) => {
  lastEvents.push({ ev, ts: new Date().toISOString() });
  if (lastEvents.length > 200) lastEvents.shift();
};

// Darija: lock باش init مايدوزش concurrent
let initInProgress = false;
let initAttempt = 0;
let heartbeatTimer = null;
let reconnectTimer = null;

// ===== Open routes =====
app.get('/', (_req, res) => res.json({ ok:true, service:'wa-bot' }));
app.get('/health', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime() }));
app.get('/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime() }));

app.get('/ready', (_req, res) => {
  if (isReady) return res.json({ ok:true });
  res.status(503).json({
    ok:false,
    error:'not_ready',
    hint:'Open /qr, scan the WhatsApp QR code, then wait for ready.'
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
        <h2>QR not generated yet…</h2><p>Refresh in a few seconds.</p>
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
  res.json({
    ok:true,
    isAuthenticated,
    isReady,
    initAttempt,
    events:lastEvents.slice(-50)
  });
});

// ===== Helpers =====
const asyncHandler = (fn) => (req,res,next)=> Promise.resolve(fn(req,res,next)).catch(next);

// ===== Protected APIs =====
app.get('/me', asyncHandler(async (_req, res) => {
  if (!isReady || !client) return res.status(503).json({ ok:false, error:'not_ready' });
  const info = client.info || null;
  res.json({
    ok:true,
    me: info ? {
      pushname: info.pushname,
      wid: info.wid?._serialized ?? null,
      platform: info.platform
    } : null
  });
}));

app.get('/groups', asyncHandler(async (_req, res) => {
  if (!isReady || !client) return res.status(503).json({ ok:false, error:'not_ready' });
  const chats = await client.getChats();
  const groups = chats.filter(c=>c.isGroup).map(g=>({
    id: g.id?._serialized,
    name: g.name,
    participantsCount: g.participants?.length ?? null
  }));
  res.json({ ok:true, count: groups.length, groups });
}));

app.post('/send', asyncHandler(async (req, res) => {
  if (!isReady || !client) return res.status(503).json({ ok:false, error:'not_ready' });
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ ok:false, error:'to_and_message_required' });
  await client.sendMessage(to, message);
  res.json({ ok:true });
}));

// ===== WhatsApp init / destroy =====
function getPuppeteerOptions() {
  // Darija: فـ Render خاص args ديال no-sandbox الخ...
  const opts = {
    headless: true,
    protocolTimeout: 180000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--no-zygote',
      '--disable-gpu',
      '--disable-features=site-per-process',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  };
  return opts;
}

async function destroyClientSafely() {
  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;

    if (client) {
      // Darija: destroy باش مايبقاش page bindings قدام
      await client.destroy();
    }
  } catch (e) {
    console.warn('destroy warning:', e?.message || e);
  } finally {
    client = null;
    isAuthenticated = false;
    isReady = false;
  }
}

async function initWhatsApp() {
  if (initInProgress) return; // Darija: منع init concurrent
  initInProgress = true;
  initAttempt += 1;

  try {
    await fs.mkdir(DATA_PATH,  { recursive:true });
    await fs.mkdir(CACHE_PATH, { recursive:true });

    // Darija: LocalAuth فـ disk
    const authStrategy = new LocalAuth({ dataPath: DATA_PATH });

    const puppeteerOpts = getPuppeteerOptions();

    // Darija: local cache ديال web version باش يقلّ inject تغييرات
    const webVersionCache = {
      type: 'local',
      path: CACHE_PATH
    };

    client = new Client({
      authStrategy,
      puppeteer: puppeteerOpts,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      restartOnAuthFail: true,
      qrMaxRetries: 8,
      webVersionCache
    });

    client.on('qr', (qr) => {
      lastQr = qr;
      isAuthenticated = false;
      isReady = false;
      pushEv('qr');
      console.log('[QR] new QR generated');
    });

    client.on('authenticated', () => {
      isAuthenticated = true;
      pushEv('authenticated');
      console.log('Authenticated 🔐');
    });

    client.on('ready', () => {
      isReady = true;
      pushEv('ready');
      console.log('WhatsApp ready ✅');
    });

    client.on('loading_screen', (p, msg) => {
      console.log('Loading…', p, msg);
    });

    client.on('change_state', (s) => {
      console.log('[State]', s);
    });

    client.on('disconnected', async (reason) => {
      pushEv(`disconnected:${reason}`);
      console.warn('[Disconnected]', reason);

      // Darija: دير destroy + schedule reconnect
      await destroyClientSafely();
      scheduleReconnect();
    });

    // Darija: initialize مرة وحدة
    await client.initialize();

    // Darija: heartbeat باش نعرف state بلا ما نطيّح الخدمة
    heartbeatTimer = setInterval(async () => {
      try {
        if (!client) return;
        const s = await client.getState().catch(() => null);
        console.log('[Heartbeat]', s, 'ready=', isReady);
      } catch {}
    }, 20000);

    pushEv('init_ok');
  } catch (e) {
    pushEv('init_error');
    console.error('Client init error:', e?.message || e);

    // Darija: إذا طاحت init دير destroy وعاود retry ب backoff
    await destroyClientSafely();
    scheduleReconnect();
  } finally {
    initInProgress = false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  // Darija: backoff بسيط (يزيد شوية كل مرة)
  const base = 5000;
  const extra = Math.min(60000, initAttempt * 5000);
  const wait = base + extra;

  console.log(`[Reinit] scheduling init in ${wait}ms`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await initWhatsApp();
  }, wait);
}

// ===== Start HTTP then init WA =====
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log(`[Auth] Using LocalAuth at ${DATA_PATH}`);
});

initWhatsApp();

// ===== Guards =====
process.on('unhandledRejection', (r) => {
  console.error('unhandledRejection', r?.message || r);
});
process.on('uncaughtException', (e) => {
  console.error('uncaughtException', e?.message || e);
});
