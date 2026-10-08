// Source Dailymotion : recherche d'épisodes (souvent en VO turque) via l'API publique,
// puis lecture du flux HLS de la vidéo via le relais de l'addon.
//
// - Catalogue : tape un nom de série (ex. "Hercai") dans la recherche de Stremio.
// - Aussi utilisé par yoturkish.js : propose des flux Dailymotion pour un épisode YoTurkish.
// Les vidéos peuvent être bloquées selon le pays du serveur : les logs "[dm]" l'indiquent.
const axios = require('axios');
const { playable } = require('./proxy');

const API = 'https://api.dailymotion.com';
const SITE = 'https://www.dailymotion.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const http = axios.create({ timeout: 12000, headers: { 'User-Agent': UA } });

const MIN_DURATION = 600; // secondes : ignore les extraits et bandes-annonces courts
const SKIP = /fragman|teaser|trailer|promo|özet|ozet|sahne|klip|müzik|muzik|jenerik|röportaj|roportaj|tanıtım|tanitim/i;

const enc = (s) => Buffer.from(s).toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString();

const CHARS = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u', é: 'e', è: 'e' };
const slugify = (s) =>
  String(s)
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîûéè]/g, (c) => CHARS[c])
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function cleanName(s) {
  return s
    .replace(/\b\d+\s*\.?\s*(sezon|season)\b/gi, '')
    .replace(/\b(sezon|season)\s*\d+\b/gi, '')
    .replace(/^[\s\-–—|:,.[\]()]+/, '')
    .replace(/[\s\-–—|:,.[\]()]+$/, '')
    .trim();
}

// "Hercai 12. Bölüm Full HD" -> { name: "Hercai", ep: 12 } ; "Hercai Episode 5" -> { name: "Hercai", ep: 5 }
function parseTitle(title) {
  let m = title.match(/(?<!\d)(\d{1,3})\s*\.?\s*(?:bölüm|bolum|episode|ep)\b/i);
  if (!m) m = title.match(/\b(?:bölüm|bolum|episode|ep\.?)\s*(\d{1,3})\b/i);
  if (!m) return null;
  const name = cleanName(title.slice(0, m.index));
  return name ? { name, ep: Number(m[1]) } : null;
}

async function search(q, page = 1) {
  const { data } = await http.get(`${API}/videos`, {
    params: {
      search: q,
      fields: 'id,title,duration,owner.screenname,thumbnail_360_url',
      limit: 100,
      page,
      sort: 'relevance',
    },
  });
  return { list: data.list || [], more: !!data.has_more };
}

const usable = (v) => v && v.title && !SKIP.test(v.title) && Number(v.duration) >= MIN_DURATION;

// ---------- Catalogue (recherche uniquement) ----------
async function catalog({ search: q, skip = 0 }) {
  if (!q || Number(skip) > 0) return [];
  const want = slugify(q);
  const { list } = await search(q);
  const groups = new Map();
  for (const v of list) {
    if (!usable(v)) continue;
    const p = parseTitle(v.title);
    if (!p) continue;
    const key = slugify(p.name);
    if (!key || !(key.includes(want) || want.includes(key))) continue;
    const g = groups.get(key) || { name: p.name, poster: v.thumbnail_360_url, eps: new Set() };
    g.eps.add(p.ep);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.eps.size - a.eps.size)
    .slice(0, 30)
    .map((g) => ({
      id: 'dm:' + enc(g.name),
      type: 'series',
      name: g.name,
      poster: g.poster,
      description: `${g.eps.size} épisode(s) trouvé(s) sur Dailymotion`,
    }));
}

// ---------- Fiche série : épisodes trouvés par recherche ----------
async function meta(id) {
  const name = dec(id.slice(3));
  const key = slugify(name);
  const eps = new Map(); // numéro -> vignette
  let poster;
  for (let page = 1; page <= 3; page++) {
    const { list, more } = await search(name, page);
    for (const v of list) {
      if (!usable(v)) continue;
      const p = parseTitle(v.title);
      if (!p || slugify(p.name) !== key) continue;
      if (!eps.has(p.ep)) eps.set(p.ep, v.thumbnail_360_url);
      poster = poster || v.thumbnail_360_url;
    }
    if (!more) break;
  }
  if (!eps.size) return null;

  const videos = [...eps.keys()]
    .sort((a, b) => a - b)
    .map((n, i) => ({
      id: 'dm:ep:' + enc(`${name}|${n}`),
      title: `Bölüm ${n}`,
      season: 1,
      episode: n,
      thumbnail: eps.get(n),
      released: new Date(Date.UTC(2000, 0, 1 + i)).toISOString(),
    }));
  return { id, type: 'series', name, poster, background: poster, videos };
}

// ---------- Flux ----------
async function hlsUrl(videoId) {
  try {
    const { data } = await http.get(`${SITE}/player/metadata/video/${videoId}`, {
      headers: { Referer: SITE + '/', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
    });
    if (data.error) {
      console.log('[dm] indisponible', videoId, data.error.title || data.error.code || '');
      return null;
    }
    const auto = ((data.qualities || {}).auto || []).find((x) => /mpegurl/i.test(x.type || ''));
    if (!auto) console.log('[dm] pas de flux HLS pour', videoId);
    return auto ? auto.url : null;
  } catch (e) {
    console.log('[dm] erreur métadonnées', videoId, e.response ? `HTTP ${e.response.status}` : e.code || e.message);
    return null;
  }
}

const fmt = (sec) => {
  const m = Math.round(Number(sec) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
};

// Cherche "<série> <n>. Bölüm" sur Dailymotion et renvoie des flux Stremio lisibles.
async function streamsFor(name, ep) {
  const n = Number(ep);
  if (!name || !n) return [];
  const key = slugify(name);
  let list = [];
  try {
    ({ list } = await search(`${name} ${n}. Bölüm`));
  } catch (e) {
    console.log('[dm] erreur recherche :', e.response ? `HTTP ${e.response.status}` : e.code || e.message);
    return [];
  }

  const matches = list
    .filter(usable)
    .map((v) => ({ v, p: parseTitle(v.title) }))
    .filter((x) => x.p && x.p.ep === n && slugify(x.p.name).includes(key))
    .sort((a, b) => Number(b.v.duration) - Number(a.v.duration))
    .slice(0, 5);

  console.log(`[dm] "${name}" ${n} : ${matches.length} vidéo(s) candidate(s)`);

  const headers = { Referer: SITE + '/', Origin: SITE, 'User-Agent': UA };
  const out = await Promise.all(
    matches.map(async ({ v }) => {
      const url = await hlsUrl(v.id);
      if (!url) return null;
      const owner = v['owner.screenname'] || 'Dailymotion';
      return playable({ name: 'Dailymotion', title: `${owner} · ${fmt(v.duration)}\n${v.title}`, url, headers });
    })
  );
  return out.filter(Boolean);
}

async function stream(id) {
  const raw = dec(id.slice('dm:ep:'.length));
  const cut = raw.lastIndexOf('|');
  if (cut < 1) return [];
  return streamsFor(raw.slice(0, cut), raw.slice(cut + 1));
}

module.exports = {
  prefix: 'dm:',
  catalogId: 'dailymotion',
  catalogName: 'Dailymotion (VO)',
  types: ['series'],
  catalog, meta, stream, streamsFor,
};
