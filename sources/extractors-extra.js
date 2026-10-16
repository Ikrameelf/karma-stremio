// Extracteurs supplémentaires, portés depuis Extractorlar.kt (plugin CloudStream Cs-Karma).
// Vidzy : extraction des flux vidéo directement exposés par la page.
// Ne contourne pas les contrôles d'accès ni les protections DRM.
async function resolveVidzy(url, referer) {
  let u;

  try {
    u = new URL(url);
  } catch {
    return [];
  }

  if (!/(^|\.)vidzy\.(cc|org)$/i.test(u.hostname)) {
    return null;
  }

  try {
    const { data } = await axios.get(url, {
      timeout: 9000,
      maxContentLength: 2000000,
      responseType: 'text',
      headers: {
        'User-Agent': UA,
        'Referer': referer || u.origin + '/'
      }
    });

    const html = String(data);
    const decoded = html
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');

    const patterns = [
      /<source\b[^>]*\bsrc=["']([^"']+)["']/gi,
      /["']file["']\s*:\s*["']([^"']+)["']/gi,
      /["'](?:hls|playlist|video_url)["']\s*:\s*["']([^"']+)["']/gi
    ];

    const found = new Set();

    for (const re of patterns) {
      for (const m of decoded.matchAll(re)) {
        try {
          const candidate = new URL(m[1], url);

          if (
            /^https?:$/.test(candidate.protocol) &&
            /\.(m3u8|mp4)(?:$|[?#])/i.test(candidate.href)
          ) {
            found.add(candidate.href);
          }
        } catch {}
      }
    }

    return [...found].slice(0, 3).map(videoUrl => ({
      url: videoUrl,
      kind: /\.m3u8(?:$|[?#])/i.test(videoUrl) ? 'HLS' : 'MP4',
      headers: {
        'Referer': u.origin + '/',
        'User-Agent': UA
      }
    }));
  } catch (err) {
    console.log(
      `Vidzy : ${err.response
        ? 'HTTP ' + err.response.status
        : err.code || err.message}`
    );

    return [];
  }
}
// resolveExtra(url, referer) renvoie [{ url, kind, headers }], ou null si l'hôte n'est pas géré / échoue
// (dans ce cas extractors.js continue avec ses méthodes génériques).
// Si l'hôte a fait un timeout, renvoie un tableau vide avec la propriété timedOut = true.
if (vidzy !== null) return vidzy;
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';
const T = 9000;
const T_FAST = 4500; // hôtes souvent lents (uqload, vidzy) : on n'attend pas plus longtemps

const lastSegment = (url) => url.split('?')[0].split('/').filter(Boolean).pop();
const asJson = (d) => (typeof d === 'string' ? JSON.parse(d) : d);

// ───────────── Veev (veev.to) ─────────────
const jsInt = (x) => {
  const n = parseInt(x, 10);
  return Number.isNaN(n) ? 0 : n;
};

// Décompression de type LZW utilisée par Veev.
function veevDecode(enc) {
  try {
    const lut = {};
    let n = 256;
    let c = enc[0];
    const out = [c];
    for (let i = 1; i < enc.length; i++) {
      const ch = enc[i];
      const code = enc.charCodeAt(i);
      const nc = code < 256 ? ch : (lut[code] !== undefined ? lut[code] : c + c[0]);
      out.push(nc);
      lut[n++] = c + nc[0];
      c = nc;
    }
    return out.join('');
  } catch {
    return enc;
  }
}

function veevBuildArray(enc) {
  const d = [];
  const chars = enc.split('');
  if (!chars.length) return d;
  let count = jsInt(chars.shift());
  while (count > 0) {
    const cur = [];
    for (let i = 0; i < count; i++) {
      if (!chars.length) break;
      cur.unshift(jsInt(chars.shift()));
    }
    d.push(cur);
    if (!chars.length) break;
    count = jsInt(chars.shift());
  }
  return d;
}

function hexToStr(hex) {
  const h = String(hex).trim();
  return Buffer.from(h.length % 2 ? '0' + h : h, 'hex').toString('utf8');
}

function veevDecodeUrl(enc, tArray) {
  let ds = enc;
  for (const t of tArray) {
    if (t === 1) ds = ds.split('').reverse().join('');
    ds = hexToStr(ds).split('dXRmOA==').join('');
  }
  return ds;
}

async function veev(url) {
  const origin = new URL(url).origin;
  const r = await axios.get(url, { timeout: T, responseType: 'text', headers: { 'User-Agent': UA, Referer: origin + '/' } });
  const html = String(r.data);
  const finalUrl = (r.request && r.request.res && r.request.res.responseUrl) || url;
  const mediaId = lastSegment(finalUrl);

  const re = /[\.\s'](?:fc|_vvto\[[^\]]*)(?:['\]]*)?\s*[:=]\s*['"]([^'"]+)/g;
  const encs = [...html.matchAll(re)].map((m) => m[1]);
  let ch = null;
  for (const f of encs.reverse()) {
    const dec = veevDecode(f);
    if (dec !== f) { ch = dec; break; }
  }
  if (!ch) { console.log('  ↳ VEEV : paramètre "ch" introuvable'); return []; }

  const tArrays = veevBuildArray(ch);
  if (!tArrays.length) return [];

  const api = `${origin}/dl?op=player_api&cmd=gi&file_code=${encodeURIComponent(mediaId)}&ch=${encodeURIComponent(ch)}&ie=1`;
  const resp = await axios.get(api, { timeout: T, headers: { 'User-Agent': UA, Referer: url } });
  const j = asJson(resp.data);
  if (!j || j.status !== 'success' || !j.file || j.file.file_status !== 'OK' || !Array.isArray(j.file.dv)) {
    console.log('  ↳ VEEV : réponse API inattendue');
    return [];
  }
  const out = [];
  for (const s of j.file.dv) {
    if (!s || !s.s) continue;
    const link = veevDecodeUrl(veevDecode(s.s), tArrays[0]);
    if (/^https?:/i.test(link)) {
      out.push({ url: link, kind: /\.m3u8/i.test(link) ? 'HLS' : 'MP4', headers: { Referer: origin + '/', 'User-Agent': UA } });
    }
  }
  console.log(`  ↳ VEEV ${origin} : ${out.length} lien(s) décodé(s)`);
  return out;
}

// ───────────── Vidzy ─────────────
// Le plugin force toujours vidzy.cc (les liens vidzy.org renvoient une page d'attente).
async function vidzy(url, referer) {
  const m = url.match(/(?:\/d\/|\/download\/|\/file\/|\/f\/|\/v\/|\/embed-)([a-z0-9]+)/i);
  if (!m) return [];
  const host = 'vidzy.cc';
  const embed = `https://${host}/embed-${m[1]}.html`;
  const findScript = (h) => [...h.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((x) => x[1])
    .find((s) => s.includes('sources:') && s.includes('m3u8'));
  let script = null;
  // La page peut être une page d'attente (« Chargement de la vidéo ») : un second essai après 1,5 s.
  for (let attempt = 1; attempt <= 2 && !script; attempt++) {
    const html = String((await axios.get(embed, {
      timeout: T_FAST, responseType: 'text', headers: { 'User-Agent': UA, Referer: referer || `https://${host}/` },
    })).data);
    script = findScript(html);
    if (!script) {
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '?';
      console.log(`  ↳ VIDZY : script du lecteur introuvable (essai ${attempt}/2, ${html.length} octets, titre « ${title.trim()} »)`);
      if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
      else console.log(`  ↳ VIDZY EXTRAIT : ${html.replace(/\s+/g, ' ').slice(0, 800)}`);
    }
  }
  if (!script) return [];

  const encoded = (script.match(/\}\)\("([A-Za-z0-9+/=]+)"\)/) || [])[1];
  if (!encoded) return [];

  let H = 0;
  for (const c of host) H = (H + c.charCodeAt(0)) & 0xff;
  const rev = Buffer.from(encoded, 'base64').reverse();
  let res = '';
  for (let i = 0; i < rev.length; i++) {
    const kk = (0x3d + i * 89 + H) & 0xff;
    res += String.fromCharCode(rev[i] ^ kk);
  }
  if (!res.startsWith('http')) return [];
  return [{ url: res, kind: 'HLS', headers: { Referer: `https://${host}/`, Origin: `https://${host}`, 'User-Agent': UA } }];
}

// ───────────── Vidaraa / Vidara (vidara.to) ─────────────
async function vidaraa(url) {
  const origin = new URL(url).origin;
  const r = await axios.post(origin + '/api/stream', { filecode: lastSegment(url), device: 'web' }, {
    timeout: T, headers: { Referer: url, Origin: origin, 'User-Agent': UA },
  });
  const d = asJson(r.data);
  const s = d && d.streaming_url;
  if (!s) {
    console.log(`  ↳ VIDARA : pas de streaming_url (${JSON.stringify(d).slice(0, 200)})`);
    return [];
  }
  console.log(`  ↳ VIDARA ${origin} : 1 lien décodé`);
  return [{ url: s, kind: /\.m3u8/i.test(s) ? 'HLS' : 'MP4', headers: { Referer: origin + '/', 'User-Agent': UA } }];
}

// ───────────── GoodStream ─────────────
async function goodstream(url) {
  const origin = new URL(url).origin;
  const body = new URLSearchParams({ op: 'embed', file_code: lastSegment(url), auto: '1', referer: '' }).toString();
  const r = await axios.post(origin + '/dl', body, {
    timeout: T, responseType: 'text',
    headers: { Referer: url, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const src = (String(r.data).match(/file\s*:\s*"(.*?)"/) || [])[1];
  if (!src) return [];
  return [{ url: src, kind: 'HLS', headers: { Referer: origin + '/', Origin: origin, 'User-Agent': UA } }];
}

// ───────────── FireStream (diagnostic) ─────────────
// La page contient <script id="video-data" type="application/json">{...}</script> en clair.
// Pour l'instant on affiche seulement son contenu dans les logs : à partir de là on pourra écrire l'extracteur.
async function firestream(url, referer) {
  const r = await axios.get(url, {
    timeout: T_FAST, responseType: 'text', maxContentLength: 3000000,
    headers: { 'User-Agent': UA, Referer: referer || new URL(url).origin + '/' },
  });
  const html = String(r.data);
  const m = html.match(/<script[^>]+id=["']video-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) { console.log('  ↳ FIRESTREAM : bloc video-data introuvable'); return null; }
  console.log(`  ↳ FIRESTREAM video-data : ${m[1].replace(/\s+/g, ' ').slice(0, 1200)}`);
  return null; // on laisse les méthodes génériques continuer
}

// ───────────── Uqload ─────────────
// Même logique que le plugin : en-têtes Firefox + cookies de la page transmis au flux.
async function uqload(url, referer) {
  const { unpackAll } = require('./extractors'); // chargé à l'appel pour éviter une dépendance circulaire
  const origin = new URL(url).origin;
  const FF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0';
  const r = await axios.get(url, {
    timeout: T_FAST, responseType: 'text', maxContentLength: 3000000,
    headers: {
      'User-Agent': FF,
      Referer: referer || origin + '/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  const html = String(r.data);
  const text = unpackAll(html) + '\n' + html;
  const cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const m3u8 = (text.replace(/\\\//g, '/').match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/) || [])[0];
  const mp4 = (text.replace(/\\\//g, '/').match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/) || [])[0];
  const link = m3u8 || mp4;
  if (!link) return [];
  const headers = { 'User-Agent': FF, Accept: '*/*', Origin: origin, Referer: origin + '/' };
  if (cookie) headers.Cookie = cookie;
  return [{ url: link, kind: m3u8 ? 'HLS' : 'MP4', headers }];
}

async function resolveExtra(url, referer) {
  const vidzy = await resolveVidzy(url, referer);
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  try {
    if (/(^|\.)veev\./i.test(host)) return await veev(url);
    if (/(^|\.)vidzy\./i.test(host)) return await vidzy(url, referer);
    if (/(^|\.)vidaraa?\./i.test(host)) return await vidaraa(url); // vidara.to ET vidaraa.*
    if (/(^|\.)goodstream\./i.test(host)) return await goodstream(url);
    if (/(^|\.)uqload\./i.test(host)) return await uqload(url, referer);
    if (/(^|\.)firestream\./i.test(host)) return await firestream(url, referer);
  } catch (e) {
    const timedOut = /ECONNABORTED|ETIMEDOUT/.test(e.code || '');
    console.log(`  ↳ extra ${host} : ÉCHEC ${e.response ? 'HTTP ' + e.response.status : e.code || e.message}`);
    if (timedOut) {
      // Inutile de réessayer la même page avec la méthode générique : on signale le timeout.
      const empty = [];
      empty.timedOut = true;
      return empty;
    }
  }
  return null;
}

module.exports = { resolveExtra };
