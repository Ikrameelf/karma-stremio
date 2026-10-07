// Relais vidéo intégré : Stremio mobile ne sait pas envoyer les en-têtes Referer/Origin exigés par les serveurs vidéo.
// L'addon télécharge donc lui-même le flux avec les bons en-têtes et le renvoie au téléphone.
const crypto = require('crypto');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SECRET = process.env.PROXY_SECRET || crypto.randomBytes(16).toString('hex');
const PUBLIC = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString();
const sign = (u, h) => crypto.createHmac('sha256', SECRET).update(u + '\n' + h).digest('base64url');

function proxyUrl(target, headers) {
  if (!PUBLIC) return null;
  const ext = (target.match(/\.(m3u8|mp4|mkv|webm|ts|m4s|aac|key)(?=$|\?)/i) || [])[1] || 'bin';
  const u = b64(target);
  const h = b64(JSON.stringify(headers || {}));
  return `${PUBLIC}/proxy/${u}/${h}/${sign(u, h)}/v.${ext.toLowerCase()}`;
}

// Construit l'objet "stream" Stremio : via le relais si possible, sinon avec proxyHeaders (tablette/TV).
function playable({ name, title, url, headers }) {
  const p = proxyUrl(url, headers);
  if (p) return { name, title, url: p };
  return { name, title, url, behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } } };
}

function rewritePlaylist(text, base, headers) {
  const wrap = (u) => {
    const abs = new URL(u, base).href;
    return proxyUrl(abs, headers) || abs;
  };
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
    return wrap(t);
  }).join('\n');
}

const toText = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  stream.on('error', reject);
});

async function handler(req, res) {
  const { u, h, sig } = req.params;
  const good = Buffer.from(sign(u, h));
  const given = Buffer.from(String(sig));
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return res.status(403).end();

  let target, headers;
  try { target = unb64(u); headers = JSON.parse(unb64(h)); } catch { return res.status(400).end(); }

  const out = { 'User-Agent': UA, ...headers };
  if (req.headers.range) out.Range = req.headers.range;

  try {
    const up = await axios.get(target, {
      headers: out, responseType: 'stream', timeout: 20000, maxRedirects: 5, validateStatus: (s) => s < 400,
    });
    const type = String(up.headers['content-type'] || '');
    res.set('Access-Control-Allow-Origin', '*');

    if (/mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(target)) {
      const text = await toText(up.data);
      const finalUrl = (up.request && up.request.res && up.request.res.responseUrl) || target;
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritePlaylist(text, finalUrl, headers));
    }

    res.status(up.status);
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (up.headers[k]) res.set(k, up.headers[k]);
    }
    up.data.on('error', () => res.destroy());
    res.on('error', () => up.data.destroy());
    up.data.pipe(res);
    req.on('close', () => up.data.destroy());
  } catch (e) {
    console.log('proxy ÉCHEC', e.response ? `HTTP ${e.response.status} (serveur : ${e.response.headers['server'] || '?'})` : e.code || e.message, target.slice(0, 120));
    if (!res.headersSent) res.status(502).end();
  }
}

module.exports = { playable, handler, proxyUrl, rewritePlaylist };
