// Source Nuvio : exécute les providers du dossier providers/ (bundles Nuvio de Gowaru)
// et renvoie leurs flux, via ta route /proxy comme les autres sources.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { playable } = require('./proxy');

const TMDB_KEY = process.env.TMDB_API_KEY || process.env.TMDB_KEY || '';
const DIR = path.join(__dirname, '..', 'providers');

// DIAGNOSTIC (à retirer une fois le problème réglé) : journalise chaque requête
// faite par les providers (statut, durée, serveur), pour voir où ils s'arrêtent.
if (!globalThis.__nuvioFetchPatched) {
  globalThis.__nuvioFetchPatched = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const t0 = Date.now();
    try {
      const res = await realFetch(input, init);
      const server = res.headers.get('server') || '';
      const cf = res.headers.get('cf-mitigated') ? ' cf-mitigated' : '';
      console.log(`[nuvio-fetch] ${res.status} ${Date.now() - t0}ms ${server}${cf} ${url.slice(0, 140)}`);
      return res;
    } catch (e) {
      const code = e.code || (e.cause && e.cause.code) || e.message;
      console.log(`[nuvio-fetch] ECHEC ${code} ${Date.now() - t0}ms ${url.slice(0, 140)}`);
      throw e;
    }
  };
}

// Tous les .js de providers/ sont utilisés, sauf ceux de EXCLUDE.
function listProviders() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.slice(0, -3))
      .filter((n) => !EXCLUDE.includes(n));
  } catch (e) {
    return [];
  }
}

const tmdbCache = new Map();
async function toTmdbId(imdb, kind) {
  const key = `${imdb}:${kind}`;
  if (tmdbCache.has(key)) return tmdbCache.get(key);
  const { data } = await axios.get(`https://api.themoviedb.org/3/find/${imdb}`, {
    params: { api_key: TMDB_KEY, external_source: 'imdb_id' }, timeout: 15000,
  });
  const list = kind === 'movie' ? data.movie_results : data.tv_results;
  const tmdb = list && list[0] ? list[0].id : null;
  if (tmdb) tmdbCache.set(key, tmdb);
  return tmdb;
}

function withTimeout(promise, ms, name) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => { console.log(`Nuvio ${name}: timeout (${ms} ms)`); resolve([]); }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function stream(id, type) {
  if (!TMDB_KEY) { console.error('Nuvio: définissez TMDB_API_KEY'); return []; }
  const [imdb, s = '1', e = '1'] = id.split(':');
  const kind = type === 'movie' ? 'movie' : 'tv';
  const tmdb = await toTmdbId(imdb, kind);
  if (!tmdb) return [];

  const lists = await Promise.all(listProviders().map(async (name) => {
    try {
      const provider = require(path.join(DIR, `${name}.js`));
      const found = await withTimeout(
        provider.getStreams(tmdb, kind, Number(s) || 1, Number(e) || 1), TIMEOUT_MS, name);
      const ok = (found || []).filter((x) => x && typeof x.url === 'string' && /^https?:/i.test(x.url));
      console.log(`Nuvio ${name}: ${ok.length} flux`);
      return ok.map((x) => playable({
        name: `Nuvio ${name}`,
        title: x.title || x.name || name,
        url: x.url,
        headers: x.headers || {},
      }));
    } catch (err) {
      console.log(`Nuvio ${name}: ERREUR ${err.message}`);
      return [];
    }
  }));
  return lists.flat();
}

module.exports = {
  prefix: 'tt', // IDs IMDb, comme Movix
  types: ['movie', 'series'],
  stream,
};
