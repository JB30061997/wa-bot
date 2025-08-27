const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(express.json());

// تحقق من API_KEY
const API_KEY = process.env.API_KEY || 'default_key';
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// Endpoint صحة
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }
});

client.on('qr', qr => console.log('Scan QR:', qr));
client.on('ready', () => console.log('WhatsApp ready ✅'));

app.get('/groups', async (req, res) => {
  const chats = await client.getChats();
  res.json({ groups: chats.filter(c => c.isGroup).map(c => c.name) });
});

app.post('/send', async (req, res) => {
  const { group, text } = req.body;
  if (!group || !text) return res.status(400).json({ ok: false, error: 'group & text required' });

  const chats = await client.getChats();
  const grp = chats.find(c => c.isGroup && c.name.toLowerCase() === group.toLowerCase());
  if (!grp) return res.status(404).json({ ok: false, error: 'Group not found' });

  await client.sendMessage(grp.id._serialized, text);
  res.json({ ok: true, message: 'sent' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Server listening on', PORT));

client.initialize();
