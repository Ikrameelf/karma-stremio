const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.elisasaddictions.fr';
const INDEXES = [
  '/dizis-index/dizisdeaaz',
  '/dizis-index/diziscomplets',
  '/dizis-index/rom-com',
  '/dizis-index/dramas',
  '/dizis-index/historique',
  '/dizis-index/fantastique',
  '/dramas',
];
const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  },
  responseType: 'text',
  validateStatus: (s) => s >= 200 && s < 400,
});
const cache = new Map();
const TTL = 10 * 60 * 1000;
const encode = (s) => Buffer.from(s, 'utf8').toString('base64url');
const decode = (s) => Buffer.from(s, 'base64url').toString('utf8');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function siteUrl(href, base) {
  try {
    const u = new URL(href, base || BASE);
    return u.hostname === 'www.elisasaddictions.fr' || u.hostname === 'elisasaddictions.fr' ? u.href : null;
  } catch (_) { return null; }
}

async function load(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < TTL) return cached.$;
  const response = await http.get(url);
  const $ = cheerio.load(response.data);
  cache.set(url, { time: Date.now(), $ });
  return $;
}

function isEpisodeLabel(label) {
  return /(?:épisode|episode)\s*\d+/i.test(label);
}

async function allSeries() {
  const result = new Map();
  for (const path of INDEXES) {
    const indexUrl = BASE + path;
    try {
      const $ = await load(indexUrl);
      $('a[href]').each((_, el) => {
        const a = $(el);
        const url = siteUrl(a.attr('href'), indexUrl);
        const name = clean(a.text())
          .replace(/\s+(Trad|Traduction)\s+(en pause|en cours|complète).*$/i, '')
          .replace(/\s+-\s+(COMPLET|EN PAUSE|EN COURS).*$/i, '')
          .trim();
        if (!url || !name || name.length > 65 || isEpisodeLabel(name)) return;
        if (/^https?:\/\/(www\.)?elisasaddictions\.fr\/(dizis|dramas|films|aide|contact|politique)/i.test(url)) return;
        if (/^(accueil|voir tous les posts|dizis|dramas\/lakorns|films|aide|contact)$/i.test(name)) return;
        if (!result.has(url)) result.set(url, { url, name });
      });
    } catch (e) {
      console.error('[ELISA] index', path, e.message);
    }
  }
  return [...result.values()];
}

async function episodeList(seriesUrl) {
  const $ = await load(seriesUrl);
  const found = new Map();
  $('a[href]').each((_, el) => {
    const a = $(el);
    const url = siteUrl(a.attr('href'), seriesUrl);
    const label = clean(a.text());
    if (url && isEpisodeLabel(label) && !found.has(url)) found.set(url, label);
  });
  return [...found.entries()].map(([url, title], i) => ({
    id: 'elisa:episode:' + encode(url),
    title,
    season: 1,
    episode: i + 1,
  }));
}

async function catalog({ search, skip = 0 } = {}) {
  const series = await allSeries();
  const term = clean(search).toLocaleLowerCase('fr');
  const filtered = series.filter((s) => !term || s.name.toLocaleLowerCase('fr').includes(term));
  const offset = Math.max(0, Number(skip) || 0);
  return filtered.slice(offset, offset + 100).map((s) => ({
    id: 'elisa:series:' + encode(s.url),
    type: 'series',
    name: s.name,
  }));
}

async function meta(id) {
  if (!id.startsWith('elisa:series:')) return null;
  const url = decode(id.slice('elisa:series:'.length));
  const $ = await load(url);
  const name = clean($('h1').first().text()) || clean($('title').text()).split('|')[0] || 'Série';
  const description = clean($('meta[name="description"]').attr('content'));
  const videos = await episodeList(url);
  return { id, type: 'series', name, description, videos };
}

async function stream(id, type) {
  if (type !== 'series' || !id.startsWith('elisa:episode:')) return [];
  const url = decode(id.slice('elisa:episode:'.length));
  const $ = await load(url);
  const links = new Set();
  $('a[href], source[src], video[src]').each((_, el) => {
    const raw = $(el).attr('href') || $(el).attr('src');
    if (raw && /\.(mp4|m3u8)(?:[?#]|$)|workers\.dev\/file\//i.test(raw)) {
      try { links.add(new URL(raw, url).href); } catch (_) {}
    }
  });
  const html = $.html();
  const matches = html.match(/https?:\\?\/\\?\/[^"'\s<>]+\.(?:mp4|m3u8)(?:\?[^"'\s<>]*)?/gi) || [];
  matches.forEach((link) => links.add(link.replace(/\\\//g, '/').replace(/&amp;/g, '&')));
  return [...links].map((link, i) => ({
    name: "Elisa's Addictions",
    title: 'Lecteur ' + (i + 1),
    url: link,
    behaviorHints: { notWebReady: true },
  }));
}

module.exports = {
  prefix: 'elisa:',
  catalogId: 'elisa-catalog',
  catalogName: "Elisa's Addictions",
  types: ['series'],
  genres: [],
  catalog,
  meta,
  stream,
};
