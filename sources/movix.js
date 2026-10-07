// Port Stremio du provider CloudStream "Movix" (Cs-Karma) : addon de STREAMS uniquement.
// Le catalogue et les fiches viennent de Cinemeta : Movix s'affiche sur les titres Stremio normaux (IDs IMDb).
const axios = require('axios');
const { resolveEmbed } = require('./extractors');
const { playable } = require('./proxy');

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';

const cleanDomain = (u) => String(u || '').trim()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

// Comme MovixHelper.updatemainurl() du Kotlin : le domaine actif est publié dans address.json.
let cachedDomain = { value: null, at: 0 };
async function getDomain() {
  if (cachedDomain.value && Date.now() - cachedDomain.at < 6 * 3600 * 1000) return cachedDomain.value;
  try {
    const { data } = await axios.get('https://movix.online/address.json', { timeout: 8000, headers: { 'User-Agent': UA } });
    const url = data && data.active && data.active[0] && data.active[0].url;
    if (url) {
      cachedDomain = { value: cleanDomain(url), at: Date.now() };
      console.log('Movix domaine actif :', cachedDomain.value);
      return cachedDomain.value;
    }
  } catch (e) {
    console.log('Movix : address.json inaccessible (' + (e.code || e.message) + ')');
  }
  return cachedDomain.value || cleanDomain(process.env.MOVIX_DOMAIN); // repli manuel
}

const tmdbCache = new Map();

async function toTmdbId(imdb, type) {
  const key = `${imdb}:${type}`;
  if (tmdbCache.has(key)) return tmdbCache.get(key);
  const { data } = await axios.get(`https://api.themoviedb.org/3/find/${imdb}`, {
    params: { api_key: TMDB_KEY, external_source: 'imdb_id' }, timeout: 15000,
  });
  const list = type === 'movie' ? data.movie_results : data.tv_results;
  const tmdb = list && list[0] ? list[0].id : null;
  tmdbCache.set(key, tmdb);
  return tmdb;
}

function endpoints(API, type, id, imdb, s, e) {
  const q = `?season=${s}&episode=${e}`;
  if (type === 'movie') {
    return [
      ['Movix', `${API}/links/movie/${id}`],
      ['Movix TMDB', `${API}/tmdb/movie/${id}`],
      ['IMDB', `${API}/imdb/movie/${imdb}`],
      ['FStream', `${API}/fstream/movie/${id}`],
      ['Wiflix', `${API}/wiflix/movie/${id}`],
      ['J1F', `${API}/j1f/movie/${id}`],
      ['Cpasmal', `${API}/cpasmal/movie/${id}`],
      ['Purstream', `${API}/purstream/movie/${id}/stream`],
      ['SwiftFlow', `${API}/swiftflow/movie/${id}`],
      ['KissKh', `${API}/kisskh/movie/${id}`],
      ['Frembed', `https://frembed.surf/api/public/v1/movies/${id}`],
    ];
  }
  return [
    ['Movix', `${API}/links/tv/${id}${q}`],
    ['Movix TMDB', `${API}/tmdb/tv/${id}${q}`],
    ['IMDB', `${API}/imdb/tv/${imdb}`],
    ['FStream', `${API}/fstream/tv/${id}/season/${s}?episode=${e}`],
    ['Wiflix', `${API}/wiflix/tv/${id}/${s}?episode=${e}`],
    ['Cpasmal', `${API}/cpasmal/tv/${id}/${s}/${e}`],
    ['Purstream', `${API}/purstream/tv/${id}/stream?season=${s}&episode=${e}`],
    ['SwiftFlow', `${API}/swiftflow/tv/${id}/season/${s}?episode=${e}`],
    ['J1F', `${API}/j1f/tv/${id}/season/${s}?episode=${e}`],
    ['KissKh', `${API}/kisskh/tv/${id}${q}`],
    ['Frembed', `https://frembed.surf/api/public/v1/tv/${id}?sa=${s}&epi=${e}`],
    ['Drama', `${API}/drama/tv/${id}${q}`],
  ];
}

const NOISE = /\.(jpe?g|png|webp|gif|svg|ico|js|css|vtt|srt|ass|woff2?)(\?|$)|image\.tmdb\.org|youtube\.com|youtu\.be/i;
const DIRECT = /\.(m3u8|mp4|mkv|webm)(\?|$)/i;

// Parseur générique : on extrait toutes les URLs de la réponse, sans connaître le format exact de chaque API.
function extractUrls(data) {
  const text = (typeof data === 'string' ? data : JSON.stringify(data)).replace(/\\\//g, '/');
  return [...new Set(text.match(/https?:\/\/[^"'\s\\<>]+/g) || [])].filter((u) => !NOISE.test(u));
}

const asJson = (d) => { if (typeof d !== 'string') return d; try { return JSON.parse(d); } catch { return null; } };

// Purstream : le Kotlin prend la DERNIÈRE source et utilise l'URL du flux comme Referer.
function parsePurstream(data) {
  const j = asJson(data);
  const src = j && Array.isArray(j.sources) ? j.sources[j.sources.length - 1] : null;
  if (!src || !src.url) return { urls: [], direct: [] };
  return { urls: [], direct: [{ url: src.url, title: src.name || 'M3U8', headers: { Referer: src.url } }] };
}

// J1F : les liens sont soit en clair, soit encodés en base64.
function parseJ1F(data) {
  const j = asJson(data);
  const players = (j && j.players) || {};
  const urls = [...(players.vf || []), ...(players.vostfr || [])]
    .map((x) => String((x && x.url) || '').trim())
    .filter(Boolean)
    .map((u) => (/^https?:/i.test(u) ? u : Buffer.from(u, 'base64').toString('utf8').trim()))
    .filter((u) => /^https?:/i.test(u));
  return { urls, direct: [] };
}

async function stream(id, type) {
  if (!TMDB_KEY) {
    console.error('Movix: définissez TMDB_API_KEY');
    return [];
  }
  const DOMAIN = await getDomain();
  if (!DOMAIN) {
    console.error('Movix: domaine introuvable (address.json KO et MOVIX_DOMAIN vide)');
    return [];
  }
  const API = `https://api.${DOMAIN}/api`;
  const HEADERS = { 'User-Agent': UA, Origin: `https://${DOMAIN}`, Referer: `https://${DOMAIN}/` };
  const [imdb, s = '1', e = '1'] = id.split(':');
  const kind = type === 'movie' ? 'movie' : 'tv';
  const tmdb = await toTmdbId(imdb, kind);
  if (!tmdb) return [];

  const results = await Promise.allSettled(
    endpoints(API, kind, tmdb, imdb, s, e).map(async ([brand, url]) => {
      try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 15000, validateStatus: (c) => c < 400 });
        let parsed;
        if (brand === 'Purstream') parsed = parsePurstream(res.data);
        else if (brand === 'J1F') parsed = parseJ1F(res.data);
        else parsed = { urls: extractUrls(res.data), direct: [] };
        console.log(`Movix ${brand}: HTTP ${res.status}, ${parsed.urls.length + parsed.direct.length} lien(s)`);
        return { brand, urls: parsed.urls, direct: parsed.direct };
      } catch (err) {
        const code = err.response ? `HTTP ${err.response.status}` : err.code || err.message;
        console.log(`Movix ${brand}: ÉCHEC (${code}) ${url}`);
        throw err;
      }
    })
  );

  const seen = new Set();
  const direct = [];
  const embeds = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const d of r.value.direct) {
      if (seen.has(d.url)) continue;
      seen.add(d.url);
      direct.push(playable({ name: `Movix ${r.value.brand}`, title: d.title, url: d.url, headers: d.headers }));
    }
    for (const url of r.value.urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (DIRECT.test(url)) {
        direct.push(playable({
          name: `Movix ${r.value.brand}`,
          title: DIRECT.exec(url)[1].toUpperCase(),
          url,
          headers: { Referer: HEADERS.Referer, Origin: HEADERS.Origin, 'User-Agent': UA },
        }));
      } else if (!url.includes(`api.${DOMAIN}`)) {
        embeds.push({ brand: r.value.brand, url });
      }
    }
  }

  // Tente d'extraire un lien vidéo de chaque page d'embed (en parallèle, limité pour rester rapide).
  const resolved = await Promise.all(
    embeds.slice(0, 15).map(async ({ brand, url }) => {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const links = await resolveEmbed(url, HEADERS.Referer);
      console.log(`Movix embed ${host}: ${links.length} lien(s) vidéo`);
      return links.length
        ? links.map((l) => playable({ name: `Movix ${brand}`, title: `${host} · ${l.kind}`, url: l.url, headers: l.headers }))
        : [{ name: `Movix ${brand}`, title: `${host} · navigateur`, externalUrl: url }];
    })
  );
  const extra = embeds.slice(15).map(({ brand, url }) => ({ name: `Movix ${brand}`, title: 'Ouvrir dans le navigateur', externalUrl: url }));
  const all = [...direct, ...resolved.flat(), ...extra];
  const playableLinks = all.filter((x) => x.url);
  const browserLinks = all.filter((x) => !x.url);
  // Les liens "navigateur" ne sont gardés que s'il n'y a rien de lisible (ou si SHOW_BROWSER_LINKS=1).
  return playableLinks.length && !process.env.SHOW_BROWSER_LINKS ? playableLinks : [...playableLinks, ...browserLinks];
}

module.exports = {
  prefix: 'tt', // IDs IMDb
  types: ['movie', 'series'],
  stream,
};
