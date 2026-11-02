const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.elisasaddictions.fr';
const ALL_SERIES_URL = BASE + '/dizis-index/dizisdeaaz';
const http = axios.create({
  timeout: 12000,
  maxRedirects: 4,
  maxContentLength: 5 * 1024 * 1024,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  },
  responseType: 'text',
  validateStatus: (s) => s >= 200 && s < 400,
});

// Cache très léger : uniquement le HTML brut de quelques pages, jamais les arbres Cheerio.
const cache = new Map();
const TTL = 3 * 60 * 1000;
const MAX_CACHE = 4;
const encode = (s) => Buffer.from(s, 'utf8').toString('base64url');
const decode = (s) => Buffer.from(s, 'base64url').toString('utf8');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function siteUrl(href, base) {
  try {
    const u = new URL(href, base || BASE);
    return ['www.elisasaddictions.fr', 'elisasaddictions.fr'].includes(u.hostname) ? u.href : null;
  } catch (_) { return null; }
}

async function getHtml(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < TTL) return cached.html;
  const response = await http.get(url);
  const html = String(response.data || '');
  if (html.length > 5 * 1024 * 1024) throw new Error('Page Elisa trop volumineuse');
  cache.delete(url);
  cache.set(url, { time: Date.now(), html });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return html;
}

function labelFor($, a) {
  const img = a.find('img').first();
  return clean(
    a.attr('aria-label') ||
    a.attr('title') ||
    img.attr('alt') ||
    img.attr('title') ||
    a.text()
  );
}

function isEpisodeLabel(label) {
  return /(?:épisode|episode)\s*\d+/i.test(label);
}

// L'index A-Z contient toutes les Dizis. Le menu de cette même page référence aussi
// les huit Dramas/Lakorns : inutile de parcourir des dizaines d'URL de catégories.
async function allSeries() {
  const html = await getHtml(ALL_SERIES_URL);
  const $ = cheerio.load(html);
  const found = new Map();

  $('a[href]').each((_, el) => {
    const a = $(el);
    const url = siteUrl(a.attr('href'), ALL_SERIES_URL);
    const name = labelFor($, a)
      .replace(/\s+(Trad|Traduction)\s+(en pause|en cours|complète).*$/i, '')
      .replace(/\s+-\s+(COMPLET|EN PAUSE|EN COURS).*$/i, '')
      .trim();

    if (!url || !name || name.length > 80 || isEpisodeLabel(name)) return;
    if (url === BASE + '/' || url === ALL_SERIES_URL) return;
    if (/\/dizis-index\/|\/aide\/|\/politique|\/contact|\/films\b/i.test(new URL(url).pathname)) return;
    if (/^(accueil|voir tous les posts|dizis|dramas\/lakorns|films|aide|contact|nous soutenir)$/i.test(name)) return;

    // Évite les liens de navigation génériques ; conserve les pages de séries du site.
    if (!found.has(url)) found.set(url, { url, name });
  });

  return [...found.values()];
}

async function episodeList(seriesUrl) {
  const html = await getHtml(seriesUrl);
  const $ = cheerio.load(html);
  const found = new Map();

  $('a[href]').each((_, el) => {
    const a = $(el);
    const url = siteUrl(a.attr('href'), seriesUrl);
    const label = labelFor($, a);
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
  try {
    const series = await allSeries();
    const term = clean(search).toLocaleLowerCase('fr');
    const filtered = series.filter((s) => !term || s.name.toLocaleLowerCase('fr').includes(term));
    const offset = Math.max(0, Number(skip) || 0);
    console.log('[ELISA] Catalogue:', series.length, 'séries détectées,', filtered.length, 'après recherche');
    return filtered.slice(offset, offset + 100).map((s) => ({
      id: 'elisa:series:' + encode(s.url),
      type: 'series',
      name: s.name,
    }));
  } catch (e) {
    console.error('[ELISA] Catalogue en erreur:', e.message);
    return [];
  }
}

async function meta(id) {
  if (!id.startsWith('elisa:series:')) return null;
  const url = decode(id.slice('elisa:series:'.length));
  const html = await getHtml(url);
  const $ = cheerio.load(html);
  const name = clean($('h1').first().text()) || clean($('title').text()).split('|')[0] || 'Série';
  const description = clean($('meta[name="description"]').attr('content'));
  const videos = await episodeList(url);
  return { id, type: 'series', name, description, videos };
}

async function stream(id, type) {
  if (type !== 'series' || !id.startsWith('elisa:episode:')) return [];
  const url = decode(id.slice('elisa:episode:'.length));
  const html = await getHtml(url);
  const $ = cheerio.load(html);
  const links = new Set();

  $('a[href], source[src], video[src]').each((_, el) => {
    const raw = $(el).attr('href') || $(el).attr('src');
    if (raw && /\.(mp4|m3u8)(?:[?#]|$)|workers\.dev\/file\//i.test(raw)) {
      try { links.add(new URL(raw, url).href); } catch (_) {}
    }
  });

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
