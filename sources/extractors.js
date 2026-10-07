// Extracteurs génériques pour les pages d'embed (Uqload, Vidmoly, Sendvid, Sibnet, etc.).
// Principe : télécharger la page, décompresser le JS "packed" éventuel, puis chercher les liens .m3u8/.mp4.
// Si rien n'est trouvé : ouvre l'embed dans un vrai navigateur (Playwright) et capte les requêtes réseau.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const VIDEO = /\.(m3u8|mp4|mkv|webm)(\?|$)/i;
const NOISE = /\.(jpe?g|png|webp|gif|svg|vtt|srt)(\?|$)/i;

// Décompresse le format eval(function(p,a,c,k,e,d){...}) (Dean Edwards packer), très courant sur les hébergeurs.
function unpackAll(src) {
  const re = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/gs;
  let out = '';
  for (const m of src.matchAll(re)) {
    let p = m[1];
    const a = Number(m[2]);
    let c = Number(m[3]);
    const k = m[4].split('|');
    const base = (n) => (n < a ? '' : base(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + base(c) + '\\b', 'g'), k[c]);
    out += '\n' + p.replace(/\\'/g, "'");
  }
  return out;
}

function candidates(text, pageUrl) {
  const t = text.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  const out = new Set();
  const add = (u) => {
    try {
      const abs = new URL(u, pageUrl).href;
      if (VIDEO.test(abs) && !NOISE.test(abs)) out.add(abs);
    } catch { /* URL invalide */ }
  };
  const patterns = [
    /file\s*:\s*["']([^"']+)["']/gi,
    /sources\s*:\s*\[\s*["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+)["']/gi,
    /property=["']og:video(?::\w+)?["'][^>]+content=["']([^"']+)["']/gi,
    /\bsrc\s*:\s*["']([^"']+)["']/gi,
    /https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)[^"'\s\\<>]*/gi,
  ];
  for (const re of patterns) for (const m of t.matchAll(re)) add(m[1] || m[0]);
  return [...out];
}

// Doodstream : la page publie un chemin /pass_md5/... qui donne la base du lien vidéo.
const DOOD = /(^|\.)(dood|d0o0d|d000d|ds2play|doodstream|dooood|dsvplay)[\w-]*\./i;
async function resolveDood(url) {
  const u = new URL(url);
  const embed = `${u.origin}/e/${u.pathname.split('/').filter(Boolean).pop()}`;
  const { data: html } = await axios.get(embed, { timeout: 4000, responseType: 'text', headers: { 'User-Agent': UA, Referer: u.origin + '/' } });
  const md5 = String(html).match(/\/pass_md5\/[^'"]+/);
  if (!md5) return [];
  const token = md5[0].split('/').pop();
  const { data: base } = await axios.get(u.origin + md5[0], { timeout: 4000, responseType: 'text', headers: { 'User-Agent': UA, Referer: embed } });
  if (!/^https?:/.test(String(base))) return [];
  const rand = Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  return [{ url: `${String(base).trim()}${rand}?token=${token}&expiry=${Date.now()}`, kind: 'MP4', headers: { Referer: u.origin + '/', 'User-Agent': UA } }];
}

// Secours : ouvre l'embed dans Chromium, tente de lancer la lecture et capte les requêtes .m3u8/.mp4.
// Utile quand le lien vidéo est construit par JavaScript et n'apparaît pas dans le HTML.
async function sniffWithBrowser(url, referer) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    console.error('[extractors] playwright non installé : npm i playwright && npx playwright install chromium');
    return [];
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    ctx.on('page', (p) => p.close().catch(() => {})); // ferme les pop-ups publicitaires
    const page = await ctx.newPage();
    const found = new Set();
    page.on('request', (r) => {
      const u = r.url();
      if (VIDEO.test(u) && !NOISE.test(u)) found.add(u.split('#')[0]);
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000, referer: referer || undefined }).catch(() => {});

    for (let i = 0; i < 16 && !found.size; i++) {
      if (i % 4 === 1) {
        // tente de déclencher la lecture (lecteur principal + iframes)
        for (const f of page.frames()) {
          await f.click('video, .jw-icon-display, .vjs-big-play-button, .plyr__control--overlaid, button', { timeout: 500 }).catch(() => {});
        }
        await page.mouse.click(400, 300).catch(() => {});
      }
      await page.waitForTimeout(500);
    }
    return [...found];
  } finally {
    await browser.close();
  }
}

const toLinks = (list, origin) =>
  list.slice(0, 3).map((u) => ({
    url: u,
    kind: /\.m3u8/i.test(u) ? 'HLS' : 'MP4',
    headers: { Referer: origin + '/', 'User-Agent': UA },
  }));

// Retourne [{ url, kind, headers }] (liste vide si rien n'est trouvé).
// opts.sniff = false désactive le secours navigateur (pour ne pas le lancer pour rien).
async function resolveEmbed(url, referer, opts = {}) {
  let origin;
  try { origin = new URL(url).origin; } catch { return []; }
  const allowSniff = opts.sniff !== false && !process.env.NO_BROWSER_SNIFF;
  let found = [];

  try {
    if (DOOD.test(new URL(url).hostname)) {
      const d = await resolveDood(url);
      if (d.length) return d;
    }
    const { data } = await axios.get(url, {
      timeout: 10000,
      responseType: 'text',
      headers: { 'User-Agent': UA, Referer: referer || origin + '/' },
    });
    const html = typeof data === 'string' ? data : JSON.stringify(data);
    found = candidates(html + '\n' + unpackAll(html), url);
    if (!found.length) console.log(`  ↳ ${origin} : page lue (${html.length} octets) mais aucun lien vidéo trouvé`);
  } catch (err) {
    const why = err.response
      ? `HTTP ${err.response.status} (serveur : ${err.response.headers['server'] || '?'})`
      : err.code || err.message;
    console.log(`  ↳ ${origin} : ÉCHEC ${why}`);
  }

  if (!found.length && allowSniff) {
    console.log(`  ↳ ${origin} : tentative via navigateur...`);
    try {
      found = await sniffWithBrowser(url, referer);
      console.log(`  ↳ ${origin} : navigateur → ${found.length} lien(s) vidéo`);
    } catch (e) {
      console.log(`  ↳ ${origin} : navigateur ÉCHEC ${e.message}`);
    }
  }

  return toLinks(found, origin);
}

module.exports = { resolveEmbed, unpackAll };
