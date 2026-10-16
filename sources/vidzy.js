
const axios = require('axios');
const { resolveExtra } = require('./extractors-extra');
const { playable } = require('./proxy');

const API = 'https://vidzy.org/api';
const TMDB = 'https://api.themoviedb.org/3';

async function stream(id, type) {
  if (type !== 'movie') return [];

  // Stremio fournit normalement un identifiant IMDb : tt1234567.
  const imdbId = String(id).match(/^(tt\d+)$/)?.[1];
  if (!imdbId) return [];

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error('Vidzy : TMDB_API_KEY manquante');
    return [];
  }

  try {
    // Convertit l'identifiant IMDb en identifiant TMDB.
    const found = await axios.get(`${TMDB}/find/${imdbId}`, {
      params: {
        api_key: apiKey,
        external_source: 'imdb_id',
      },
      timeout: 10000,
    });

    const tmdbId = found.data?.movie_results?.[0]?.id;
    if (!tmdbId) return [];

    // Récupère les informations Vidzy.
    const response = await axios.get(`${API}/${tmdbId}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Karma-Stremio/1.0' },
    });

    const data = response.data;
    if (!data?.available || !data?.embed) return [];

    // La page du film contient un lecteur intégré.
    const page = await axios.get(data.embed, {
      timeout: 12000,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        Referer: 'https://vidzy.org/',
      },
    });

    const iframe = page.data.match(
      /<iframe\b[^>]*\bsrc=["']([^"']+)["']/i
    )?.[1];

    if (!iframe) {
      console.log('Vidzy : lecteur intégré introuvable', imdbId);
      return [];
    }

    const embedUrl = new URL(iframe, data.embed).href;

    // Réutilise l'extracteur Vidzy déjà présent.
    const extracted = await resolveExtra(embedUrl, data.embed);
    if (!Array.isArray(extracted) || !extracted.length) {
      console.log('Vidzy : aucun flux direct extrait', imdbId);
      return [];
    }

    const title =
      `${data.title || 'Vidéo'}${
        data.languages?.length
          ? ` (${data.languages.join(', ')})`
          : ''
      }`;

    return extracted
      .filter((item) => item?.url)
      .map((item) =>
        playable({
          name: 'Vidzy',
          title,
          url: item.url,
          headers: item.headers || {
            Referer: 'https://vidzy.cc/',
            Origin: 'https://vidzy.cc',
          },
        })
      );
  } catch (error) {
    console.error(
      'Vidzy :',
      error.response
        ? `HTTP ${error.response.status}`
        : error.code || error.message
    );
    return [];
  }
}

module.exports = {
  prefix: 'tt',
  types: ['movie'],
  stream,
};
