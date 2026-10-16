
const axios = require('axios');

const API = 'https://vidzy.org/api';

async function stream(id, type) {
  // À ce stade, seuls les identifiants TMDB numériques
  // peuvent être utilisés avec cette API.
  const tmdbId = String(id).match(/^vidzy:(\d+)$/)?.[1];
  if (!tmdbId || type !== 'movie') return [];

  try {
    const { data } = await axios.get(`${API}/${tmdbId}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Karma-Stremio/1.0' },
    });

    if (!data?.available || !data?.embed) return [];

    return [{
      name: 'Vidzy',
      title: `${data.title || 'Vidéo'}${data.languages?.length ? ` (${data.languages.join(', ')})` : ''}`,
      externalUrl: data.embed,
    }];
  } catch (error) {
    console.error('Vidzy:', error.message);
    return [];
  }
}

module.exports = {
  prefix: 'vidzy:',
  types: ['movie'],
  stream,
};
