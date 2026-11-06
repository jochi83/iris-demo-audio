import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocket, WebSocketServer } from 'ws';

const app = express();
const port = Number(process.env.PORT || 3000);
const origin = process.env.FRONTEND_ORIGIN || '';
const limit = Number(process.env.RATE_LIMIT_PER_MINUTE || 30);
const buckets = new Map();

function allowedOrigin(value) {
  return !origin || value === origin || /^http:\/\/localhost(:\d+)?$/.test(value || '');
}
function guard(req, res, next) {
  if (!allowedOrigin(req.headers.origin)) return res.status(403).json({ error: 'Origen no autorizado.' });
  const id = req.ip || 'unknown', now = Date.now();
  const row = buckets.get(id) || { started: now, count: 0 };
  if (now - row.started > 60_000) { row.started = now; row.count = 0; }
  row.count += 1; buckets.set(id, row);
  if (row.count > limit) return res.status(429).json({ error: 'Demasiadas solicitudes. Probá en un minuto.' });
  next();
}

app.use(cors({ origin: (value, done) => done(null, allowedOrigin(value)), methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '2mb' }));
app.get('/health', (req, res) => res.json({ ok: true, providers: {
  openai: Boolean(process.env.OPENAI_API_KEY), deepseek: Boolean(process.env.DEEPSEEK_API_KEY), gemini: Boolean(process.env.GEMINI_API_KEY)
} }));

const textProviders = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY' },
  deepseek: { url: 'https://api.deepseek.com/chat/completions', key: 'DEEPSEEK_API_KEY' }
};
app.post('/v1/chat/:provider', guard, async (req, res) => {
  const p = textProviders[req.params.provider];
  if (!p || !process.env[p.key]) return res.status(503).json({ error: 'Proveedor no configurado.' });
  try {
    const upstream = await fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[p.key]}` }, body: JSON.stringify(req.body) });
    res.status(upstream.status).json(await upstream.json());
  } catch { res.status(502).json({ error: 'No se pudo contactar al proveedor.' }); }
});

app.post('/v1/image', guard, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini no está configurado.' });
  try {
    const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(req.body)
    });
    res.status(upstream.status).json(await upstream.json());
  } catch { res.status(502).json({ error: 'No se pudo generar la imagen.' }); }
});

const server = app.listen(port, () => console.log(`IRIS backend listening on ${port}`));
const wss = new WebSocketServer({ noServer: true });
function proxyLive(client, target, headers = {}) {
  const upstream = new WebSocket(target, { headers });
  const close = (code, reason) => { if (client.readyState === WebSocket.OPEN) client.close(code, String(reason || '').slice(0, 120)); };
  upstream.on('open', () => client.send(JSON.stringify({ type: 'iris.proxy.ready' })));
  upstream.on('message', data => client.readyState === WebSocket.OPEN && client.send(data));
  upstream.on('error', () => close(1011, 'No se pudo conectar al proveedor'));
  upstream.on('close', (code, reason) => close(code || 1000, reason));
  client.on('message', data => upstream.readyState === WebSocket.OPEN && upstream.send(data));
  client.on('close', () => upstream.close());
}
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!allowedOrigin(req.headers.origin)) return socket.destroy();
  let target, headers = {};
  if (url.pathname === '/v1/live/gemini' && process.env.GEMINI_API_KEY) {
    target = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  } else if (url.pathname === '/v1/live/openai' && process.env.OPENAI_API_KEY) {
    target = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini';
    headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  } else return socket.destroy();
  wss.handleUpgrade(req, socket, head, client => proxyLive(client, target, headers));
});
