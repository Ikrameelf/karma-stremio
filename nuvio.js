// nuvio.js : charge un provider Nuvio (bundle) et convertit ses flux en flux Stremio
// Prérequis : Node 18+ (fetch global) et une clé TMDB gratuite dans la variable d'env TMDB_KEY
const path = require('path');

const TMDB_KEY = process.env.TMDB_KEY;

async function imdbToTmdb(imdbId, type) {
  const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
  const j = await (await fetch(url)).json();
  const hit = type === 'movie' ? j.movie_results?.[0] : j.tv_results?.[0];
  return hit ? hit.id : null;
}

// providerName = nom du fichier dans providers/ sans .js (ex. "coflix")
async function getStreams(providerName, stremioType, stremioId) {
  const [imdb, season, episode] = stremioId.split(':');
  const type = stremioType === 'movie' ? 'movie' : 'tv';

  const tmdbId = await imdbToTmdb(imdb, type);
  if (!tmdbId) return [];

  const provider = require(path.join(__dirname, 'providers', `${providerName}.js`));
  const list = await provider.getStreams(tmdbId, type, Number(season) || 1, Number(episode) || 1);

  return (list || []).map((s) => ({
    name: s.name || providerName,
    title: s.title,
    url: s.url,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: s.headers || {} },
    },
  }));
}

module.exports = { getStreams };

// Exemple d'utilisation dans ton index.js :
//
// const { getStreams } = require('./nuvio');
// builder.defineStreamHandler(async ({ type, id }) => {
//   const lists = await Promise.all(
//     ['coflix', 'frenchstream'].map((p) => getStreams(p, type, id).catch(() => []))
//   );
//   return { streams: lists.flat() };
// });
