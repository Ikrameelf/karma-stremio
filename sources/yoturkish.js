// Port Stremio du provider CloudStream "YoTurkish" (Cs-Karma).
const axios = require('axios');
const cheerio = require('cheerio');
const { resolveEmbed } = require('./extractors');
const { playable } = require('./proxy');
const tmdb = require('./tmdb');
const youtube = require('./youtube');
const turkvost = require('./turkvost');
const elisa = require('./elisasaddictions');

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

// Mapping IMDb -> chemin YoTurkish, pour permettre l'usage d'IDs IMDb
// (reconnus par les addons de sous-titres) tout en gardant le chemin du site.
const imdbToPath = new Map();
const episodeMap = new Map();
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
    // Suffixe de version pour forcer Nuvio à recharger les métadonnées (et passer aux IDs IMDb).
    const id = 'yot2:' + enc(pathOf(href));
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
  const path = dec(String(id).slice(5).split(':')[0]);
  const $ = cheerio.load(await getHtml(BASE + path));

  const name = $('h1').first().text().trim();
  if (!name) return null;
  const poster = abs($('meta[property="og:image"]').attr('content'));
  const rating = ($('span.imdb').first().text().match(/[\d.]+/) || [])[0];
  const genres = [...new Set($('span a[href*="genre/"]').map((_, e) => $(e).text().trim()).get())];
  const cast = $('span.shorting a').map((_, e) => $(e).text().trim()).get();

  // Identifiant IMDb (pour que les addons de sous-titres reconnaissent la série).
  const year = ($('span a[href*="year/"]').first().text().trim().match(/\d{4}/) || [])[0] || null;
  const imdbId = await tmdb.getImdbId(name, year).catch(() => null);
  console.log(`[yot] meta "${name}" : imdbId=${imdbId}`);
  if (imdbId) imdbToPath.set(imdbId, path);

  const videos = $('div#episodes a.episod').toArray().reverse().map((el, i) => {
    const a = $(el);
    const n = parseInt((a.text().match(/Episode\s*(\d+)/i) || [])[1], 10) || i + 1;
    const epPath = pathOf(a.attr('href'));
    let id;
    if (imdbId) {
      id = `tt${imdbId}:1:${n}`;
      episodeMap.set(id, epPath);
    } else {
      id = `yot2:ep:${enc(epPath)}:${enc(path)}:${n}`;
    }
    return {
      id,
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
  // On garde tous les serveurs de téléchargement (pas seulement le premier),
  // pour multiplier les chances d'extraction d'un lien lisible.
  $('.dl-contenti a').each((_, el) => {
    const dl = abs($(el).attr('href'));
    if (dl) found.add(dl);
  });
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

    const dls = await page.$$eval('.dl-contenti a', (as) => as.map((a) => a.href)).catch(() => []);
    dls.forEach((d) => { if (d) found.add(d); });

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
  // Compatibilité : deux formats d'identifiants d'épisode ont existé.
  //   - "yot:ep:<epEnc>:<sérieEnc>:<n>"   (format actuel)
  //   - "yot:ep:<epEnc>.<extraEnc>"        (ancien format, extraEnc = base64("nom|n"))
  // Nuvio (et Stremio) peuvent encore détenir des identifiants de l'ancien format :
  // on les accepte tous les deux pour ne jamais perdre les liens.
  if (!id) return [];
  let epPath = null, seriesPath = null, epNum = null;
  // IDs IMDb (tt...) : on retrouve le chemin YoTurkish via les maps peuplées par meta().
  if (String(id).startsWith('tt')) {
    const parts = String(id).split(':');
    const imdbId = parts[0];
    epNum = parseInt(parts[2], 10) || null;
    epPath = episodeMap.get(String(id));
    if (!epPath) return [];
    seriesPath = imdbToPath.get(imdbId) || null;
  } else if (String(id).startsWith('yot2:ep:')) {
  const rest = String(id).slice('yot2:ep:'.length);
  try {
    if (rest.includes(':')) {
      const parts = rest.split(':');
      epPath = dec(parts[0]);
      if (parts[1]) seriesPath = dec(parts[1]);
      if (parts[2]) epNum = parseInt(parts[2], 10) || null;
    } else if (rest.includes('.')) {
      const dot = rest.indexOf('.');
      epPath = dec(rest.slice(0, dot));
      const raw = dec(rest.slice(dot + 1));
      const cut = raw.lastIndexOf('|');
      if (cut > 0) {
        const name = raw.slice(0, cut);
        epNum = parseInt(raw.slice(cut + 1), 10) || null;
        // On reconstruit un chemin de série pour que YouTube et TurkVOST puissent
        // encore fonctionner avec les anciens identifiants.
        seriesPath = '/' + name + '/';
      }
    } else {
      epPath = dec(rest);
    }
  } catch (e) {
    console.log(`YoTurkish id illisible (${id}) : ${e.message}`);
    return [];
  }
  } // fin else if yot:ep:
  if (!epPath) return [];
  const epUrl = BASE + epPath;
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
    const ids = youtube.findVideos
      ? await youtube.findVideos(seriesPath, epNum, 4)
      : [await youtube.findVideo(seriesPath, epNum)];
    [...new Set(ids.filter(Boolean))].forEach((ytId, i) =>
      streams.push({
        name: 'YoTurkish',
        title: i === 0 ? 'YouTube (chaîne officielle)' : `YouTube (autre vidéo ${i})`,
        ytId,
      }));
  } catch (e) {
    console.log('YouTube :', e.response ? `HTTP ${e.response.status}` : e.message);
  }
  let turkvostStreams = [];
  try {
    turkvostStreams = await turkvost.findStreams(seriesPath, epNum);
    streams.push(...turkvostStreams);
  } catch (e) {
    console.log('TurkVOST :', e.message);
  }
  try {
    streams.push(...(await elisa.findStreams(seriesPath, epNum)));
  } catch (e) {
    console.log('Elisa :', e.message);
  }
  // Les sous-titres TurkVOST (VTT) sont aussi utiles pour les liens YouTube,
  // dont le lecteur interne n'affiche pas d'icône de sous-titres par défaut.
  const turkvostSubs = turkvostStreams.flatMap((s) => s.subtitles || []);
  // Les sous-titres TurkVOST ne sont attachés qu'au flux MP4 direct,
  // car le lecteur YouTube de Nuvio ne supporte pas les sous-titres externes.
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (/\.m3u8|\/sora\//i.test(url)) {
      streams.push(directStream(url, 'Direct (HLS)'));
      continue;
    }
    const links = await resolveEmbed(url, epUrl);
    if (links.length) links.forEach((l) => streams.push({
      name: 'YoTurkish',
      title: `Direct (${l.kind})`,
      url: l.url,
      // On évite le proxy Render (service qui se suspend) : le lien direct est
      // lisible tel quel, et on transmet les headers au lecteur via proxyHeaders.
      behaviorHints: { notWebReady: true, proxyHeaders: { request: l.headers || {} } },
    }));
    else streams.push({ name: 'YoTurkish', title: 'Ouvrir dans le navigateur', externalUrl: url });
  }
  console.log(`YoTurkish ${epUrl} : ${candidates.length} lecteur(s) trouvé(s), ${streams.filter((x) => x.ytId).length} YouTube, ${streams.filter((x) => x.url).length} direct(s), ${streams.filter((x) => x.externalUrl).length} navigateur`);
  const ytLinks = streams.filter((x) => x.ytId);
  const directLinks = streams.filter((x) => x.url);
  const browserLinks = streams.filter((x) => x.externalUrl);
  // YouTube et liens directs toujours affichés ; les liens "navigateur" uniquement si SHOW_BROWSER_LINKS est défini.
  // Nuvio (et d'autres clients) n'affichent parfois aucun lien si seuls les liens
  // "navigateur" sont disponibles et qu'ils sont masqués par défaut : on les garde
  // donc dès qu'aucun flux direct/YouTube n'a pu être extrait, sauf si
  // HIDE_BROWSER_LINKS est défini.
  const hideBrowser = process.env.HIDE_BROWSER_LINKS && !process.env.SHOW_BROWSER_LINKS;
  const showBrowser = !!process.env.SHOW_BROWSER_LINKS || (ytLinks.length === 0 && directLinks.length === 0);
  const out = [...ytLinks, ...directLinks, ...(hideBrowser ? [] : (showBrowser ? browserLinks : []))];
  // Diagnostic : affiche les URLs réellement renvoyées (proxy Render ou direct).
  console.log('[yot] URLs renvoyées :', out.map((x) => x.url || x.externalUrl || ('yt:' + x.ytId)));
  return out;
}

module.exports = {
  prefix: 'yot2:',
  catalogId: 'yoturkish2',
  catalogName: 'YoTurkish 2',
  types: ['series'],
  genres: Object.keys(GENRES),
  catalog, meta, stream,
};
