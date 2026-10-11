
const axios = require('axios');

// Vidzy : intégration expérimentale isolée.
// Cette API vérifie la disponibilité des titres, mais ne documente
// pas de flux vidéo direct compatible avec le lecteur natif de Stremio.

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const API = 'https://vidzy.org/api';
const UA = 'Karma-Stremio/1.0';

const cache = new Map();

async function toTmdbId(imdb, type) {
  if (!TMDB_KEY || !imdb.startsWith('tt')) return null;

  const key = `${imdb}:${type}`;
  if (cache.has(key)) return cache.get(key);

  const { data } = await axios.get(
    `https://api.themoviedb.org/3/find/${imdb}`,
    {
      params: {
        api_key: TMDB_KEY,
        external_source: 'imdb_id',
      },
      timeout: 10000,
    }
  );

  const list =
    type === 'movie' ? data.movie_results : data.tv_results;

  const id = list && list[0] ? list[0].id : null;
  cache.set(key, id);
  return id;
}

async function checkAvailability(tmdbId, type, season, episode) {
  // Pour un épisode, Vidzy utilise :
  // /serie/{tmdbId}/{season}/{episode}
  // Son API de disponibilité documentée accepte l'identifiant TMDB.
  const { data } = await axios.get(`${API}/${tmdbId}`, {
    timeout: 10000,
    headers: { 'User-Agent': UA },
  });

  if (!data || data.available !== true) return null;

  if (type === 'movie' && data.detectedType !== 'movie') {
    return null;
  }

  if (type === 'series' && data.detectedType !== 'series') {
    return null;
  }

  return data;
}

async function stream(id, type) {
  try {
    const [imdb, season = '1', episode = '1'] = id.split(':');

    if (type !== 'movie' && type !== 'series') return [];

    const tmdbId = await toTmdbId(
      imdb,
      type === 'movie' ? 'movie' : 'tv'
    );

    if (!tmdbId) {
      console.log('Vidzy : identifiant TMDB introuvable ou clé absente.');
      return [];
    }

    const info = await checkAvailability(
      tmdbId,
      type,
      season,
      episode
    );

    if (!info) {
      console.log(`Vidzy : titre indisponible (${tmdbId}).`);
      return [];
    }

    console.log(
      `Vidzy : ${info.title || tmdbId} disponible ; ` +
      `langues : ${(info.languages || []).join(', ')}`
    );

    // Ne pas renvoyer info.embed comme s'il s'agissait d'un flux vidéo.
    // Aucun flux natif ne sera annoncé tant qu'une URL directe compatible
    // n'est pas fournie par une interface autorisée de Vidzy.
    return [];
  } catch (error) {
    console.error(
      'Vidzy : vérification impossible :',
      error.response
        ? `HTTP ${error.response.status}`
        : error.message
    );
    return [];
  }
}

module.exports = {
  prefix: 'tt',
  types: ['movie', 'series'],
  stream,
};
