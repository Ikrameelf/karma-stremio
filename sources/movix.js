// Port Stremio du provider CloudStream "Movix" (Cs-Karma) : addon de STREAMS uniquement.
// Le catalogue et les fiches viennent de Cinemeta : Movix s'affiche sur les titres Stremio normaux (IDs IMDb).
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const DOMAIN = (process.env.MOVIX_DOMAIN || '')
  .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const API = `https://api.${DOMAIN}/api`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';
const HEADERS = { 'User-Agent': UA, Origin: `https://${DOMAIN}`, Referer: `https://${DOMAIN}/` };

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

function endpoints(type, id, imdb, s, e) {
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

async function stream(id, type) {
  if (!TMDB_KEY || !DOMAIN) {
    console.error('Movix: définissez TMDB_API_KEY et MOVIX_DOMAIN');
    return [];
  }
  const [imdb, s = '1', e = '1'] = id.split(':');
  const kind = type === 'movie' ? 'movie' : 'tv';
  const tmdb = await toTmdbId(imdb, kind);
  if (!tmdb) return [];

  const results = await Promise.allSettled(
    endpoints(kind, tmdb, imdb, s, e).map(async ([brand, url]) => {
      try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 15000, validateStatus: (c) => c < 400 });
        const urls = extractUrls(res.data);
        console.log(`Movix ${brand}: HTTP ${res.status}, ${urls.length} lien(s)`);
        return { brand, urls };
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
    for (const url of r.value.urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (DIRECT.test(url)) {
        direct.push({
          name: `Movix ${r.value.brand}`,
          title: DIRECT.exec(url)[1].toUpperCase(),
          url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: { request: { Referer: HEADERS.Referer, Origin: HEADERS.Origin, 'User-Agent': UA } },
          },
        });
      } else if (!url.includes(`api.${DOMAIN}`)) {
        embeds.push({ name: `Movix ${r.value.brand}`, title: 'Ouvrir dans le navigateur', externalUrl: url });
      }
    }
  }
  return [...direct, ...embeds];
}

module.exports = {
  prefix: 'tt', // IDs IMDb
  types: ['movie', 'series'],
  stream,
};
