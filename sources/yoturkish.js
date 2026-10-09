// Port Stremio du provider CloudStream "YoTurkish" (Cs-Karma).
const axios = require('axios');
const cheerio = require('cheerio');
const { resolveEmbed } = require('./extractors');
const { playable } = require('./proxy');
const tmdb = require('./tmdb');
const youtube = require('./youtube');

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
      id: `yot:ep:${enc(pathOf(a.attr('href')))}:${enc(path)}:${n}`,
      title: `Episode ${n}`,
      season: 1,
      episode: n,
      released: new Date(Date.UTC(2000, 0, 1 + i)).toISOString(),
    };
  });

  return tmdb.enrich({ // complète la fiche avec TMDB ; renvoie la fiche du site telle quelle en cas de problème
    id, type: 'series', name, poster, background: poster,
    description: $('div.desc.shorting p').first().text().trim() || undefined,
    releaseInfo: $('span a[href*="year/"]').first().text().trim() || undefined,
    imdbRating: rating, genres, cast, videos,
  });
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
  try { ({ chromium } = require('playwright')); } catch { return []; }
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

async function stream(id) {
  const parts = id.split(':'); // yot:ep:<épisode>:<série>:<numéro>
  const epUrl = BASE + dec(parts[2]);
  const seriesPath = parts[3] ? dec(parts[3]) : null;
  const epNum = parseInt(parts[4], 10) || null;
  let html;
  try {
    html = await getHtml(epUrl);
  } catch (e) {
    console.log(`YoTurkish ${epUrl} : page inaccessible (${e.response ? 'HTTP ' + e.response.status + ', serveur : ' + (e.response.headers['server'] || '?') : e.code || e.message})`);
    throw e;
  }

  let candidates = collectStatic(html);
  if (!candidates.length || process.env.FORCE_BROWSER) {
    try {
      candidates = [...new Set([...candidates, ...(await collectWithBrowser(epUrl))])];
    } catch (e) {
      console.error('navigateur indisponible :', e.message);
    }
  }

  const streams = [];
  try {
    const ytId = await youtube.findVideo(seriesPath, epNum);
    if (ytId) streams.push({ name: 'YoTurkish', title: 'YouTube (chaîne officielle)', ytId });
  } catch (e) {
    console.log('YouTube :', e.response ? `HTTP ${e.response.status}` : e.message);
  }
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (/\.m3u8|\/sora\//i.test(url)) {
      streams.push(directStream(url, 'Direct (HLS)'));
      continue;
    }
    const links = await resolveEmbed(url, epUrl);
    if (links.length) links.forEach((l) => streams.push(directStream(l.url, `Direct (${l.kind})`, l.headers)));
    else streams.push({ name: 'YoTurkish', title: 'Ouvrir dans le navigateur', externalUrl: url });
  }
  console.log(`YoTurkish ${epUrl} : ${candidates.length} lecteur(s) trouvé(s), ${streams.filter((x) => x.ytId).length} YouTube, ${streams.filter((x) => x.url).length} direct(s), ${streams.filter((x) => x.externalUrl).length} navigateur`);
  const ytLinks = streams.filter((x) => x.ytId);
  const directLinks = streams.filter((x) => x.url);
  const browserLinks = streams.filter((x) => x.externalUrl);
  // YouTube et liens directs toujours affichés ; les liens "navigateur" uniquement si SHOW_BROWSER_LINKS est défini.
  const showBrowser = process.env.SHOW_BROWSER_LINKS;
  return [...ytLinks, ...directLinks, ...(showBrowser ? browserLinks : [])];
}

module.exports = {
  prefix: 'yot:',
  catalogId: 'yoturkish',
  catalogName: 'YoTurkish',
  types: ['series'],
  genres: Object.keys(GENRES),
  catalog, meta, stream,
};
