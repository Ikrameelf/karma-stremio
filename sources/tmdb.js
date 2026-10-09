// Métadonnées TMDB pour les fiches de séries YoTurkish : affiche, fond, résumé, année, genres, casting (et note si le site n'en donne pas).
// Sécurité : si la clé manque, si la série n'est pas trouvée avec certitude ou si TMDB répond mal, la fiche d'origine est
// renvoyée telle quelle. Les identifiants, le titre et la liste des épisodes ne sont jamais modifiés.
// Épisodes : titre, résumé, miniature et date viennent aussi de TMDB. YoTurkish numérote tout en « saison 1 » : l'épisode n du site
// correspond au n-ième épisode de TMDB, saisons mises bout à bout. Seuls le titre et l'affichage changent, jamais season/episode/id.
// Variables d'environnement : TMDB_API_KEY (déjà utilisée par Movix), TMDB_LANG (défaut fr-FR),
// TMDB_META=0 pour tout désactiver, TMDB_EPISODES=0 pour ne désactiver que les épisodes.
const axios = require('axios');

const KEY = (process.env.TMDB_API_KEY || '').trim().replace(/^["']+|["']+$/g, '');
const LANG = process.env.TMDB_LANG || 'fr-FR';
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const TTL = 24 * 3600 * 1000;    // série trouvée : gardée 24 h
const MISS_TTL = 3600 * 1000;    // série introuvable : on réessaie dans 1 h
const cache = new Map();         // "titre|année" -> { at, d }

// "Senden Daha Güzel", "senden-daha-guzel" et "SENDEN DAHA GÜZEL" donnent la même chaîne.
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, ' ').trim();
const cleanTitle = (s) => String(s || '').replace(/[([].*?[)\]]/g, '').trim();

const get = (path, params) => axios.get(API + path, {
  params: { api_key: KEY, language: LANG, ...params }, timeout: 6000,
});

// Épisodes de TMDB mis bout à bout (saison 1, 2, 3...). Si une seule saison manque, tout serait décalé : on n'applique alors rien.
async function loadEpisodes(id, seasons) {
  if (process.env.TMDB_EPISODES === '0') return [];
  const nums = (seasons || []).filter((s) => s.season_number >= 1 && s.episode_count > 0)
    .map((s) => s.season_number).sort((a, b) => a - b).slice(0, 20);
  const parts = await Promise.all(nums.map((n) =>
    get(`/tv/${id}/season/${n}`).then((r) => r.data.episodes || []).catch(() => null)));
  if (!parts.length || parts.some((p) => p === null)) return [];
  return parts.map((p) => p.slice().sort((a, b) => a.episode_number - b.episode_number))
    .flat().map((e) => ({ name: e.name || '', overview: e.overview || '', still: e.still_path || '', air: e.air_date || '' }));
}

// Cherche la série. On n'accepte QUE un titre identique (nom ou titre original) : mieux vaut aucune donnée qu'une mauvaise.
async function load(name, year) {
  const { data } = await get('/search/tv', { query: name, include_adult: false });
  const want = norm(name);
  const exact = (data.results || []).filter((r) => norm(r.name) === want || norm(r.original_name) === want);
  if (!exact.length) return null;
  const score = (r) => ((r.origin_country || []).includes('TR') ? 2 : 0)
    + (year && String(r.first_air_date || '').startsWith(year) ? 1 : 0);
  exact.sort((a, b) => score(b) - score(a) || (b.popularity || 0) - (a.popularity || 0));
  const id = exact[0].id;

  const det = (await get(`/tv/${id}`, { append_to_response: 'credits' })).data;
  if (!det.overview && !/^en/i.test(LANG)) { // pas de résumé dans cette langue : on prend l'anglais
    try { det.overview = (await get(`/tv/${id}`, { language: 'en-US' })).data.overview || ''; } catch { /* sans importance */ }
  }
  det.flat = await loadEpisodes(id, det.seasons);
  console.log(`[tmdb] "${name}" : trouvé (TMDB ${id}, "${det.name}", ${det.flat.length} épisode(s) TMDB)`);
  return det;
}

// Fusionne : TMDB complète/remplace l'affichage, mais id, name et videos restent ceux du site.
function patch(meta, d) {
  const out = { ...meta };
  if (d.poster_path) out.poster = `${IMG}/w500${d.poster_path}`;
  if (d.backdrop_path) out.background = `${IMG}/w1280${d.backdrop_path}`;
  if (d.overview) out.description = d.overview;
  const y1 = String(d.first_air_date || '').slice(0, 4);
  const y2 = String(d.last_air_date || '').slice(0, 4);
  if (/^\d{4}$/.test(y1)) {
    out.releaseInfo = d.in_production ? `${y1}–` : (/^\d{4}$/.test(y2) && y2 !== y1 ? `${y1}–${y2}` : y1);
  }
  if (!out.imdbRating && d.vote_count >= 3 && d.vote_average) out.imdbRating = d.vote_average.toFixed(1);
  const genres = (d.genres || []).map((g) => g.name).filter(Boolean);
  if (genres.length) out.genres = genres;
  const cast = ((d.credits && d.credits.cast) || []).slice(0, 12).map((c) => c.name).filter(Boolean);
  if (cast.length) out.cast = cast;
  // Épisodes : on garde id, season et episode ; on ne change que titre, résumé, miniature et date.
  if (Array.isArray(meta.videos) && d.flat && d.flat.length) {
    const today = new Date().toISOString().slice(0, 10);
    const word = /^fr/i.test(LANG) ? 'Épisode' : 'Episode';
    out.videos = meta.videos.map((v) => {
      const e = d.flat[v.episode - 1];
      const nv = { ...v };
      if (!e) { if (/^Episode \d+$/.test(v.title || '')) nv.title = `${word} ${v.episode}`; return nv; }
      nv.title = e.name || `${word} ${v.episode}`;
      if (e.overview) nv.overview = e.overview; // pas de repli anglais ici : mieux vaut pas de résumé qu'un résumé dans une autre langue
      if (e.still) nv.thumbnail = `${IMG}/w300${e.still}`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.air) && e.air <= today) nv.released = `${e.air}T00:00:00.000Z`;
      return nv;
    });
  }
  return out;
}

// Renvoie toujours une fiche valide : la version enrichie, ou celle reçue en cas de problème.
async function enrich(meta) {
  if (!KEY || process.env.TMDB_META === '0' || !meta || !meta.name) return meta;
  try {
    const name = cleanTitle(meta.name);
    const year = (String(meta.releaseInfo || '').match(/\d{4}/) || [])[0] || null;
    const key = `${norm(name)}|${year || ''}`;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > (hit.d ? TTL : MISS_TTL)) {
      hit = { at: Date.now(), d: await load(name, year) };
      if (!hit.d) console.log(`[tmdb] "${name}" : introuvable avec certitude, fiche du site conservée`);
      cache.set(key, hit);
    }
    return hit.d ? patch(meta, hit.d) : meta;
  } catch (e) {
    console.log('[tmdb] ignoré :', e.response ? `HTTP ${e.response.status}` : e.message);
    return meta;
  }
}

module.exports = { enrich, norm };
