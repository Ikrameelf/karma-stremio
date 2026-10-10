const axios = require('axios');

const KEY = process.env.TMDB_API_KEY || '';
const LANGS = (process.env.SUB_LANGS || 'fre,fra,eng').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const OS = 'https://opensubtitles-v3.strem.io';
const TTL = 6 * 3600 * 1000;
const imdbCache = new Map();
const subCache = new Map();

const tmdb = (path, params) => axios.get('https://api.themoviedb.org/3' + path, {
  params: KEY.startsWith('eyJ') ? params : { ...params, api_key: KEY },
  headers: KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {},
  timeout: 6000,
});

async function imdbOf(slug) {
  if (imdbCache.has(slug)) return imdbCache.get(slug);
  const found = (await tmdb('/search/tv', { query: slug.replace(/-/g, ' ') })).data.results || [];
  if (!found.length) return null;
  const id = (await tmdb(`/tv/${found[0].id}/external_ids`, {})).data.imdb_id || null;
  if (id) imdbCache.set(slug, id);
  return id;
}

// Sous-titres de l'addon OpenSubtitles pour cet épisode ([] si rien ou erreur).
async function find(seriesPath, ep) {
  try {
    if (!KEY || !seriesPath || !ep) return [];
    const slug = decodeURIComponent(String(seriesPath).split('?')[0].split('/').filter(Boolean).pop() || '').toLowerCase();
    const key = `${slug}:${ep}`;
    const hit = subCache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.list;
    const imdb = await imdbOf(slug);
    if (!imdb) return [];
    const { data } = await axios.get(`${OS}/subtitles/series/${imdb}:1:${ep}.json`, { timeout: 8000 });
    const list = (data.subtitles || [])
      .filter((s) => LANGS.includes(String(s.lang).toLowerCase()))
      .slice(0, 6)
      .map((s) => ({ id: String(s.id), url: s.url, lang: s.lang }));
    subCache.set(key, { at: Date.now(), list });
    return list;
  } catch (e) {
    console.log('Sous-titres :', e.message);
    return [];
  }
}

module.exports = { find };
