// Flux officiel ATV (atv.com.tr) pour un épisode Yoturkish.
// Principe : série + numéro d'épisode -> https://www.atv.com.tr/<serie>/<n>-bolum/izle
// puis ouverture de la page dans Chromium (Playwright) pour capter l'URL .m3u8 du lecteur.
//
// ATTENTION : atv.com.tr bloque en principe la lecture depuis une IP hors de Turquie.
// Variable optionnelle ATV_PROXY (ex. http://user:pass@hote:port) = proxy turc utilisé par le navigateur.
// Variable DISABLE_ATV=1 pour désactiver complètement cette source.
const axios = require('axios');

const BASE = 'https://www.atv.com.tr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MEDIA = /\.(m3u8|mp4)(\?|$)/i;
const AD = /doubleclick|googlevideo|googlesyndication|imasdk|adservice|adnxs|smartadserver|moatads|pubads|adform|criteo/i;
const TTL = 20 * 60 * 1000;

const CHARS = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u', é: 'e', è: 'e' };

// "Kuruluş Orhan" -> "kurulus-orhan", "A.B.İ." -> "abi", "Esra Erol'da" -> "esra-erolda"
const slugify = (s) =>
  String(s)
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîûéè]/g, (c) => CHARS[c])
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function slugCandidates(name) {
  const cleaned = String(name)
    .replace(/\(.*?\)/g, '')
    .replace(/\b(season|sezon)\s*\d+/i, '')
    .trim();
  return [...new Set([slugify(cleaned), slugify(name)].filter(Boolean))];
}

async function pageExists(url) {
  try {
    const r = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'text',
      headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9' },
    });
    if (r.status !== 200) console.log(`[atv] HTTP ${r.status} pour ${url}`);
    return r.status === 200;
  } catch (e) {
    console.log('[atv] erreur page :', url, e.code || e.message);
    return false;
  }
}

function launchOptions() {
  const opts = { headless: true };
  if (process.env.ATV_PROXY) {
    try {
      const p = new URL(process.env.ATV_PROXY);
      opts.proxy = { server: `${p.protocol}//${p.host}` };
      if (p.username) opts.proxy.username = decodeURIComponent(p.username);
      if (p.password) opts.proxy.password = decodeURIComponent(p.password);
    } catch {
      console.error('[atv] ATV_PROXY invalide (format attendu : http://user:pass@hote:port)');
    }
  }
  return opts;
}

// Ouvre la page de l'épisode et capte la première playlist .m3u8 qui n'est pas une publicité.
async function sniff(url) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    console.error('[atv] playwright non installé');
    return null;
  }
  const browser = await chromium.launch(launchOptions());
  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
      viewport: { width: 1280, height: 720 },
    });
    const page = await ctx.newPage();
    ctx.on('page', (p) => { if (p !== page) p.close().catch(() => {}); }); // ferme les pop-ups

    let found = null;
    page.on('request', (r) => {
      const u = r.url();
      if (!MEDIA.test(u)) return;
      console.log('[atv] média vu :', u.slice(0, 180));
      if (!found && !AD.test(u) && /\.m3u8/i.test(u)) {
        found = { url: u, referer: (r.headers() || {}).referer || BASE + '/' };
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

    for (let i = 0; i < 40 && !found; i++) { // environ 20 s
      if (page.isClosed()) break;
      if (i === 4 || i === 12 || i === 24) {
        for (const f of page.frames()) {
          await f.click('video, .vjs-big-play-button, .jw-icon-display, .plyr__control--overlaid, [class*="play" i]', { timeout: 400 }).catch(() => {});
        }
        await page.mouse.click(640, 360).catch(() => {});
      }
      await page.waitForTimeout(500).catch(() => {});
    }
    return found;
  } finally {
    await browser.close();
  }
}

const cache = new Map(); // url de page -> { t, value }
const inflight = new Map();

async function sniffCached(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return hit.value;
  if (inflight.has(url)) return inflight.get(url);
  const p = sniff(url)
    .then((value) => { if (value) cache.set(url, { t: Date.now(), value }); return value; })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

// Retourne { url, headers } ou null.
async function atvStream(seriesName, episode) {
  if (process.env.DISABLE_ATV) return null;
  const ep = Number(episode);
  if (!seriesName || !ep) return null;

  for (const slug of slugCandidates(seriesName)) {
    const url = `${BASE}/${slug}/${ep}-bolum/izle`;
    if (!(await pageExists(url))) { console.log('[atv] introuvable :', url); continue; }
    console.log('[atv] page trouvée :', url);
    const found = await sniffCached(url);
    if (!found) {
      console.log('[atv] aucun flux capté (blocage hors Turquie ?) :', url);
      return null;
    }
    let origin = BASE;
    try { origin = new URL(found.referer).origin; } catch { /* garde BASE */ }
    return {
      url: found.url,
      headers: { Referer: found.referer, Origin: origin, 'User-Agent': UA },
    };
  }
  return null;
}

module.exports = { atvStream, slugify };
