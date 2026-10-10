// Associe un épisode YoTurkish à une vidéo YouTube (lecteur YouTube intégré de Stremio, champ "ytId").
// 1) Si la série est dans youtube-series.json, cette playlist est utilisée (réglage manuel prioritaire).
// 2) Sinon, recherche AUTOMATIQUE via l'API YouTube : d'abord la playlist de la série (résultat gardé en mémoire),
//    puis, à défaut, la vidéo de l'épisode.
//
// Variables d'environnement (Render) :
//   YOUTUBE_API_KEY   obligatoire
//   YOUTUBE_CHANNELS  optionnel : ID de chaînes autorisées, séparés par des virgules (UC...), pour ne garder que les chaînes officielles
//   YOUTUBE_AUTO=0    optionnel : désactive la recherche automatique (seul youtube-series.json compte)
const axios = require('axios');

let config = {};
try { config = require('./youtube-series.json'); } catch { /* fichier absent : pas de réglage manuel */ }

const KEY = process.env.YOUTUBE_API_KEY || '';
const CHANNELS = (process.env.YOUTUBE_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const AUTO = process.env.YOUTUBE_AUTO !== '0';
const TTL = 6 * 3600 * 1000;      // résultat trouvé : gardé 6 h
const MISS_TTL = 3600 * 1000;     // rien trouvé : on ne réessaie pas avant 1 h (la recherche coûte 100 unités de quota)
const playlistCache = new Map();  // playlistId -> { at, videos }
const seriesCache = new Map();    // slug -> { at, playlist }
const videoCache = new Map();     // slug:épisode -> { at, id }
let blockedUntil = 0;             // pause de 1 h après une erreur 403 (quota épuisé, clé refusée…)

// ---------- Outils ----------
const norm = (s) => String(s || '')
  .toLowerCase().replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const slugOf = (p) => decodeURIComponent(String(p).split('?')[0].split('/').filter(Boolean).pop() || '').toLowerCase();
const nameOf = (p) => norm(slugOf(p).replace(/-/g, ' '));
// Tous les mots du nom de la série doivent se retrouver dans le titre (accents et ponctuation ignorés).
const matches = (name, title) => {
  const words = new Set(norm(title).split(' '));
  return name.split(' ').every((w) => words.has(w));
};
const allowed = (channelId) => !CHANNELS.length || CHANNELS.includes(channelId);
const NOISE = /\b(trailer|promo|fragman|teaser|preview|clip|scene|moments|highlights)\b/i;

async function api(path, params) {
  if (Date.now() < blockedUntil) throw new Error('API YouTube en pause (quota ou clé), nouvel essai dans moins d\'1 h');
  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/' + path, { params: { ...params, key: KEY }, timeout: 8000 });
    return data;
  } catch (e) {
    const msg = e.response && e.response.data && e.response.data.error && e.response.data.error.message;
    if (msg) console.log('  ↳ API YouTube :', msg);
    if (e.response && e.response.status === 403) blockedUntil = Date.now() + 3600 * 1000;
    throw e;
  }
}

function entryFor(seriesPath) {
  const slug = slugOf(seriesPath);
  const key = Object.keys(config).find((k) => !k.startsWith('_') && k.toLowerCase() === slug);
  if (!key) return null;
  const v = config[key];
  return typeof v === 'string' ? { playlist: v, offset: 0 } : { playlist: v.playlist, offset: v.offset || 0 };
}

const EP_RES = [
  /\b(?:episode|épisode|episodio|ep|bölüm|bolum|capitulo|capítulo)\.?\s*#?(\d{1,4})\b/i,
  /\b(\d{1,4})\s*\.?\s*(?:bölüm|bolum|episode|épisode)/i,
];
function episodeNumber(title) {
  if (NOISE.test(String(title))) return null;
  for (const re of EP_RES) {
    const m = String(title).match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ---------- Playlists ----------
async function playlistVideos(playlistId) {
  const hit = playlistCache.get(playlistId);
  if (hit && Date.now() - hit.at < TTL) return hit.videos;
  const videos = [];
  let pageToken;
  for (let page = 0; page < 10; page++) { // 10 pages x 50 = 500 vidéos max
    const data = await api('playlistItems', { part: 'snippet', maxResults: 50, playlistId, pageToken });
    for (const it of data.items || []) {
      const sn = it.snippet || {};
      if (!sn.resourceId || /^(private|deleted) video$/i.test(sn.title || '')) continue;
      videos.push({ id: sn.resourceId.videoId, title: sn.title, ep: episodeNumber(sn.title) });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  playlistCache.set(playlistId, { at: Date.now(), videos });
  return videos;
}

// ---------- Recherche automatique ----------
async function searchPlaylist(name) {
  const data = await api('search', { part: 'snippet', type: 'playlist', q: `${name} episodes`, maxResults: 10 });
  const found = (data.items || []).filter((it) =>
    it.id && it.id.playlistId && matches(name, it.snippet.title) && allowed(it.snippet.channelId));
  for (const it of found.slice(0, 3)) {
    const videos = await playlistVideos(it.id.playlistId);
    if (videos.filter((v) => v.ep).length >= 2) return it.id.playlistId; // c'est bien une playlist d'épisodes
  }
  return null;
}

async function searchVideo(name, ep) {
  const data = await api('search', { part: 'snippet', type: 'video', q: `${name} episode ${ep}`, maxResults: 10, videoDuration: 'long' });
  const hit = (data.items || []).find((it) =>
    it.id && it.id.videoId && matches(name, it.snippet.title) && episodeNumber(it.snippet.title) === ep && allowed(it.snippet.channelId));
  return hit ? hit.id.videoId : null;
}

// Retourne l'identifiant de la vidéo YouTube de l'épisode, ou null.
async function findVideo(seriesPath, epNumber) {
  if (!KEY || !seriesPath || !epNumber) return null;

  const entry = entryFor(seriesPath);
  if (entry && entry.playlist) { // réglage manuel
    const videos = await playlistVideos(entry.playlist);
    const hit = videos.find((v) => v.ep === epNumber + entry.offset);
    return hit ? hit.id : null;
  }
  if (!AUTO) return null;

  const slug = slugOf(seriesPath);
  const name = nameOf(seriesPath);
  if (!name) return null;

  let s = seriesCache.get(slug);
  if (!s || Date.now() - s.at > (s.playlist ? TTL : MISS_TTL)) {
    s = { at: Date.now(), playlist: await searchPlaylist(name) };
    seriesCache.set(slug, s);
  }
  if (s.playlist) {
    const videos = await playlistVideos(s.playlist);
    const hit = videos.find((v) => v.ep === epNumber);
    if (hit) return hit.id;
  }

  const key = `${slug}:${epNumber}`;
  let v = videoCache.get(key);
  if (!v || Date.now() - v.at > (v.id ? TTL : MISS_TTL)) {
    v = { at: Date.now(), id: await searchVideo(name, epNumber) };
    videoCache.set(key, v);
  }
  return v.id;
}
const extraCache = new Map(); // slug:épisode -> { at, ids }

// Chaînes officielles reconnues par leur nom (en plus de YOUTUBE_CHANNELS, qui reste le plus fiable).
const OFFICIAL_RE = new RegExp(
  '\\b(official|resmi|show tv|star tv|kanal d|atv|trt|fox|now|tv8|kanal 7|' +
  (process.env.YOUTUBE_OFFICIAL_NAMES || 'zzzz').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).join('|') + ')\\b', 'i');
const BOLUM_RE = /\b(bölüm|bolum)\b/i;
const REUPLOAD_RE = /\b(özet|ozet|reaction|shorts?|dublaj|altyaz[ıi]|english subtitles?|spanish|arabic|multi ?sub)\b/i;

function score(it) {
  const sn = it.snippet || {};
  let s = 0;
  if (CHANNELS.includes(sn.channelId)) s += 10;      // chaîne listée dans YOUTUBE_CHANNELS
  if (OFFICIAL_RE.test(sn.channelTitle || '')) s += 5; // nom de chaîne officielle
  if (BOLUM_RE.test(sn.title || '')) s += 2;           // titre "N. Bölüm"
  if (REUPLOAD_RE.test(sn.title || '')) s -= 3;        // résumés, doublages, re-uploads
  return s;
}

// Vidéos de l'épisode, classées : chaînes officielles et "bölüm" en premier.
async function searchVideos(name, ep) {
  const data = await api('search', {
    part: 'snippet', type: 'video', q: `${name} ${ep}. bölüm`, maxResults: 25,
    videoDuration: 'long', regionCode: 'TR', relevanceLanguage: 'tr',
  });
  return (data.items || [])
    .filter((it) =>
      it.id && it.id.videoId && matches(name, it.snippet.title) &&
      episodeNumber(it.snippet.title) === ep && allowed(it.snippet.channelId))
    .map((it) => ({ id: it.id.videoId, score: score(it) }))
    .sort((a, b) => b.score - a.score);
}

async function findVideos(seriesPath, epNumber, max = 4) {
  if (!KEY || !seriesPath || !epNumber) return [];
  const manual = entryFor(seriesPath);
  const first = await findVideo(seriesPath, epNumber);
  if (manual && manual.playlist) return first ? [first] : []; // réglage manuel : on ne touche pas
  if (!AUTO) return first ? [first] : [];

  const slug = slugOf(seriesPath);
  const name = nameOf(seriesPath);
  let found = [];
  if (name) {
    const key = `${slug}:${epNumber}`;
    let hit = extraCache.get(key);
    if (!hit || Date.now() - hit.at > (hit.list.length ? TTL : MISS_TTL)) {
      try {
        hit = { at: Date.now(), list: await searchVideos(name, epNumber) };
        extraCache.set(key, hit);
      } catch (e) {
        hit = { list: [] }; // quota épuisé ou erreur : on garde au moins la première vidéo
      }
    }
    found = hit.list;
  }
  const official = found.filter((v) => v.score >= 5).map((v) => v.id);
  const others = found.filter((v) => v.score < 5).map((v) => v.id);
    return [...new Set([...official, first, ...others].filter(Boolean))].slice(0, max);
}

module.exports = { findVideo, findVideos, episodeNumber };
