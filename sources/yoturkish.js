// Port Stremio du provider CloudStream "YoTurkish" (Cs-Karma).
const axios = require('axios');
const cheerio = require('cheerio');
const { resolveEmbed } = require('./extractors');
const { playable } = require('./proxy');
const { streamsFor: dailymotionStreams } = require('./dailymotion');

const BASE = 'https://yoturkish.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const http = axios.create({ timeout: 20000, headers: { 'User-Agent': UA, Referer: BASE + '/' } });

const GENRES = {
  Adventure: '/genre/adventure/', Action: '/genre/action/', Romance: '/genre/romance/',
  Drama: '/genre/drama/', Comedy: '/genre/comedy/', Crime: '/genre/crime/',
  Family: '/genre/family/', History: '/genre/history/', Mystery: '/genre/mystery/',
  Thriller: '/genre/thriller/', War: '/genre/war/', Horror: '/genre/horror/',
};

const AD = /sharethis|pubadx|yandex|a-ads|googletagmanager|doubleclick/i;
const EMBED_HOSTS = /(engifuosi|rufiiguta|tukipasti|kitraskimisi|sssrr)\.\w+/i;
const HLS_RE = /https?:\/\/[^"'\s\\<>]+\.m3u8[^"'\s\\<>]*/gi;
const MP4_RE = /https?:\/\/[^"'\s\\<>]+\.mp4[^"'\s\\<>]*/gi;

const enc = (s) => Buffer.from(s).toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString();
const abs = (u) => { try { return u ? new URL(u, BASE).href : undefined; } catch { return undefined; } };
const pathOf = (href) => { const u = new URL(href, BASE); return u.pathname + u.search; };
const getHtml = async (url, headers = {}) => (await http.get(url, { headers, responseType: 'text' })).data;

let pageSize = 20; // ajusté automatiquement après le premier chargement

// ---------- Catalogue ----------
function parseCards($) {
  const cards = new Map();
  $('div.item').each((_, el) => {
    const a = $(el).find('a').first();
    const title = a.attr('title');
    const href = a.attr('href');
    if (!title || !href) return;
    const img = $(el).find('img').first();
    const poster = abs(img.attr('src') || img.attr('data-src'));
    const rating = ($(el).find('span.imdb').first().text().match(/[\d.]+/) || [])[0];
    const id = 'yot:' + enc(pathOf(href));
    if (!cards.has(id)) cards.set(id, { id, type: 'series', name: title.trim(), poster, imdbRating: rating });
  });
  return [...cards.values()];
}

async function catalog({ genre, search, skip = 0 }) {
  const base = genre && GENRES[genre] ? GENRES[genre] : '/series/';
  const page = Math.floor(Number(skip) / pageSize) + 1;
  let url;
  if (search) {
    const q = encodeURIComponent(search);
    url = page === 1 ? `${BASE}/?s=${q}` : `${BASE}/page/${page}/?s=${q}`;
  } else {
    url = page === 1 ? BASE + base : `${BASE}${base}page/${page}/`;
  }
  const metas = parseCards(cheerio.load(await getHtml(url)));
  if (page === 1 && metas.length) pageSize = metas.length;
  return metas;
}

// ---------- Fiche série ----------
async function meta(id) {
  const path = dec(id.slice(4));
  const $ = cheerio.load(await getHtml(BASE + path));

  const name = $('h1').first().text().trim();
  if (!name) return null;
  const poster = abs($('meta[property="og:image"]').attr('content'));
  const rating = ($('span.imdb').first().text().match(/[\d.]+/) || [])[0];
  const genres = [...new Set($('span a[href*="genre/"]').map((_, e) => $(e).text().trim()).get())];
  const cast = $('span.shorting a').map((_, e) => $(e).text().trim()).get();

  const videos = $('div#episodes a.episod').toArray().reverse().map((el, i) => {
    const a = $(el);
    const n = parseInt((a.text().match(/Episode\s*(\d+)/i) || [])[1], 10) || i + 1;
    return {
      // après le "." : nom de la série et numéro d'épisode (utilisés pour chercher sur Dailymotion)
      id: 'yot:ep:' + enc(pathOf(a.attr('href'))) + '.' + enc(`${name}|${n}`),
      title: `Episode ${n}`,
      season: 1,
      episode: n,
      released: new Date(Date.UTC(2000, 0, 1 + i)).toISOString(),
    };
  });

  return {
    id, type: 'series', name, poster, background: poster,
    description: $('div.desc.shorting p').first().text().trim() || undefined,
    releaseInfo: $('span a[href*="year/"]').first().text().trim() || undefined,
    imdbRating: rating, genres, cast, videos,
  };
}

// ---------- Streams ----------
function directStream(url, label, headers) {
  return playable({
    name: 'YoTurkish',
    title: label,
    url,
    headers: headers || { Referer: BASE + '/', Origin: BASE, 'User-Agent': UA },
  });
}

function collectStatic(html) {
  const $ = cheerio.load(html);
  const found = new Set();
  const dl = abs($('.dl-contenti a').first().attr('href'));
  if (dl) found.add(dl);
  $('iframe').each((_, el) => {
    const s = abs($(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src'));
    if (s && /^https?:/.test(s)) found.add(s);
  });
  (html.match(HLS_RE) || []).forEach((u) => found.add(u));
  return [...found].filter((u) => !AD.test(u));
}

// Équivalent du WebViewResolver de CloudStream : ouvre la page, clique les onglets, capte les liens.
async function collectWithBrowser(url) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    console.error('[yot] playwright non installé : npm i playwright && npx playwright install chromium');
    return [];
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    const found = new Set();
    const interesting = (u) =>
      (/\.m3u8|\/sora\//i.test(u) || EMBED_HOSTS.test(u)) && !/\.(js|css|png|jpe?g|woff2?|svg|json)(\?|$)/i.test(u);
    page.on('request', (r) => { if (interesting(r.url())) found.add(r.url().split('#')[0]); });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.optitabs a[href^="#tab"]', { timeout: 5000 }).catch(() => {});

    const dl = await page.$eval('.dl-contenti a', (a) => a.href).catch(() => null);
    if (dl) found.add(dl);

    const tabs = await page.$$('.optitabs a[href^="#tab"]');
    for (const tab of tabs) {
      await tab.click().catch(() => {});
      await page.waitForTimeout(1200);
      for (const f of await page.$$('#player iframe, .play iframe')) {
        const s = await f.getAttribute('src');
        if (s && /^https?:/.test(s)) found.add(s);
      }
    }
    return [...found].filter((u) => !AD.test(u));
  } finally {
    await browser.close();
  }
}

// Transforme une liste d'URLs candidates en flux Stremio (directs si possible).
async function processCandidates(candidates, epUrl, streams, seen) {
  for (const url of candidates) {
    if (!/^https?:/i.test(url) || /\/cdn-cgi\//i.test(url)) continue; // blob:, pubs/anti-bot Cloudflare
    if (seen.has(url)) continue;
    seen.add(url);
    console.log('[yot] candidat :', url);

    if (/\.m3u8|\/sora\//i.test(url)) {
      streams.push(directStream(url, 'Direct (HLS)'));
      continue;
    }

    let links = [];
    try {
      links = await resolveEmbed(url, epUrl, { sniff: !streams.some((x) => x.url) });
    } catch (e) {
      console.error('[yot] erreur resolveEmbed :', url, e.message);
    }

    if (links.length) {
      links.forEach((l) => streams.push(directStream(l.url, `Direct (${l.kind})`, l.headers)));
    } else {
      console.log('[yot] embed NON résolu (à gérer dans extractors.js) :', url);
      streams.push({ name: 'YoTurkish', title: 'Ouvrir dans le navigateur', externalUrl: url });
    }
  }
}

async function stream(id) {
  const [pathPart, extra] = id.slice('yot:ep:'.length).split('.');
  const epUrl = BASE + dec(pathPart);
  const html = await getHtml(epUrl);

  // Infos série + épisode pour Dailymotion (absentes sur les anciens ids : Dailymotion est alors ignoré)
  let epInfo = null;
  if (extra) {
    const raw = dec(extra);
    const cut = raw.lastIndexOf('|');
    if (cut > 0) epInfo = { name: raw.slice(0, cut), episode: Number(raw.slice(cut + 1)) };
  }

  const streams = [];
  const seen = new Set();

  // 1) Liens trouvés directement dans le HTML
  await processCandidates(collectStatic(html), epUrl, streams, seen);

  // 2) Navigateur : s'il n'y a aucun flux lisible, ou si FORCE_BROWSER est défini
  const hasPlayable = () => streams.some((x) => x.url);
  if (!hasPlayable() || process.env.FORCE_BROWSER) {
    try {
      await processCandidates(await collectWithBrowser(epUrl), epUrl, streams, seen);
    } catch (e) {
      console.error('[yot] navigateur indisponible :', e.message);
    }
  }

  // 3) Flux Dailymotion (recherche par nom de série + numéro d'épisode)
  if (epInfo && !process.env.DISABLE_DAILYMOTION) {
    try {
      streams.push(...(await dailymotionStreams(epInfo.name, epInfo.episode)));
    } catch (e) {
      console.error('[dm] erreur :', e.message);
    }
  }

  const playableLinks = streams.filter((x) => x.url);
  return playableLinks.length && !process.env.SHOW_BROWSER_LINKS ? playableLinks : streams;
}

module.exports = {
  prefix: 'yot:',
  catalogId: 'yoturkish',
  catalogName: 'YoTurkish',
  types: ['series'],
  genres: Object.keys(GENRES),
  catalog, meta, stream,
};
