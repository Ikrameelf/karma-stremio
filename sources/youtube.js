// Associe un épisode YoTurkish à une vidéo des chaînes YouTube officielles (via une playlist).
// Stremio lit ensuite la vidéo dans son lecteur YouTube intégré (champ "ytId").
const axios = require('axios');

let config = {};
let loadError = null;
try {
  config = require('./youtube-series.json');
} catch (e) {
  loadError = e.message; // JSON mal formé (virgule, guillemet...) ou fichier absent
  console.error('youtube-series.json illisible :', e.message);
}

const KEY = process.env.YOUTUBE_API_KEY || '';
const playlistCache = new Map(); // playlistId -> { at, videos }
const TTL = 6 * 3600 * 1000;

const slugOf = (p) => decodeURIComponent(String(p).split('?')[0].split('/').filter(Boolean).pop() || '').toLowerCase();

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
  for (const re of EP_RES) {
    const m = String(title).match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function playlistVideos(playlistId) {
  const hit = playlistCache.get(playlistId);
  if (hit && Date.now() - hit.at < TTL) return hit.videos;
  const videos = [];
  let pageToken;
  for (let page = 0; page < 10; page++) { // 10 pages x 50 = 500 vidéos max
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: { part: 'snippet', maxResults: 50, playlistId, key: KEY, pageToken },
      timeout: 8000,
    });
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

// Retourne l'identifiant de la vidéo YouTube de l'épisode, ou null.
async function findVideo(seriesPath, epNumber) {
  const entry = seriesPath && epNumber ? entryFor(seriesPath) : null;
  if (!entry || !KEY || !entry.playlist) return null;
  const videos = await playlistVideos(entry.playlist);
  const hit = videos.find((v) => v.ep === epNumber + entry.offset);
  return hit ? hit.id : null;
}

const status = () => ({
  cle_api_definie: !!KEY,
  erreur_fichier: loadError,
  series: Object.keys(config).filter((k) => !k.startsWith('_')),
});

module.exports = { findVideo, episodeNumber, status };
