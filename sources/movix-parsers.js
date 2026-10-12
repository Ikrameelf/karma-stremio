// Portage des parseurs Kotlin (MovixLinks) qui filtrent par épisode + de la source "download" (videolinks).
// Chaque parseXxx renvoie un tableau d'URLs, ou null si la réponse n'est pas du JSON (→ repli sur extractUrls).
const axios = require('axios');

const asJson = (d) => { if (typeof d !== 'string') return d; try { return JSON.parse(d); } catch { return null; } };
const txt = (d) => (typeof d === 'string' ? d : JSON.stringify(d));
const sameEp = (a, b) => a != null && b != null && (String(a) === String(b) || (Number.isFinite(+a) && +a === +b));
const urlsOf = (arr) => (Array.isArray(arr) ? arr : []).map((x) => x && (x.url || x.link)).filter(Boolean);
const findKey = (obj, ep) => Object.keys(obj || {}).find((k) => sameEp(k, ep));

// FStream : film = players{langue:[{url}]}, série = episodes{n:{languages{langue:[{url}]}}}
function parseFstream(data, type, ep) {
  const j = asJson(data);
  if (!j) return null;
  if (type === 'movie') return Object.values(j.players || j.links || {}).flatMap(urlsOf);
  const k = findKey(j.episodes, ep);
  return k ? Object.values(j.episodes[k].languages || {}).flatMap(urlsOf) : [];
}

// Wiflix : film = players{vf,vostfr}, série = episodes{n:{vf,vostfr}}
function parseWiflix(data, type, ep) {
  const j = asJson(data);
  if (!j) return null;
  const k = findKey(j.episodes, ep);
  const box = type === 'movie' ? j.players : k && j.episodes[k];
  return box ? [...urlsOf(box.vf), ...urlsOf(box.vostfr)] : [];
}

// SwiftFlow : players{vf,vostfr} ou vf/vostfr à la racine, ou episodes{n:{vf,vostfr}}
function parseSwiftflow(data, type, ep) {
  const j = asJson(data);
  if (!j) return null;
  const pick = (o) => (o ? [...urlsOf(o.vf), ...urlsOf(o.vostfr)] : []);
  const k = findKey(j.episodes, ep);
  return [...pick(j.players), ...pick(j), ...pick(k && j.episodes[k])];
}

// IMDB : iframe_src, player_links[], series[].seasons[].episodes[].versions{}.players[]
function parseImdb(data, ep, season) {
  const j = asJson(data);
  if (!j) return null;
  const out = [];
  if (j.iframe_src) out.push(j.iframe_src);
  out.push(...urlsOf(j.player_links));
  for (const serie of j.series || []) {
    for (const s of serie.seasons || []) {
      const sn = s.number ?? s.season_number; // champ non garanti : ignoré s'il n'existe pas
      if (sn != null && season != null && !sameEp(sn, season)) continue;
      for (const e of s.episodes || []) {
        if (ep != null && !sameEp(e.number, ep)) continue;
        for (const v of Object.values(e.versions || {})) out.push(...urlsOf(v.players));
      }
    }
  }
  return out;
}

// videolinks() du Kotlin : titre via cpasmal/tmdb → /search?title= → /films|series/download/... → sources m3u8/mp4 directes.
async function movixDownload(API, HEADERS, kind, tmdb, s, e) {
  const empty = { brand: 'DL', urls: [], direct: [] };
  const get = (url) => axios.get(url, { headers: HEADERS, timeout: 8000 }).then((r) => r.data);
  const q = kind === 'movie' ? '' : `?season=${s}&episode=${e}`;
  const nameRe = /"(?:title|name)"\s*:\s*"([^"]+)"/;
  let title;
  try {
    const info = await get(kind === 'movie' ? `${API}/cpasmal/movie/${tmdb}` : `${API}/cpasmal/tv/${tmdb}/${s}/${e}`);
    title = nameRe.exec(txt(info))?.[1];
  } catch { /* repli ci-dessous */ }
  if (!title) {
    try { title = nameRe.exec(txt(await get(`${API}/tmdb/${kind}/${tmdb}${q}`)))?.[1]; } catch { /* rien */ }
  }
  if (!title) return empty;

  const found = txt(await get(`${API}/search?title=${encodeURIComponent(title)}`));
  const id = /"id"\s*:\s*(\d+)/.exec(found)?.[1];
  if (!id) return empty;

  const dlUrl = kind === 'movie'
    ? `${API}/films/download/${id}`
    : `${API}/series/download/${id}/season/${s}/episode/${e}`;
  const j = asJson(await get(dlUrl));
  const direct = ((j && j.sources) || []).map((src) => {
    const url = src.m3u8 || src.src;
    if (!url) return null;
    const quality = String(src.quality || '').replace(/\D/g, '');
    const title = [src.language, quality && quality + 'p'].filter(Boolean).join(' · ') || 'Video';
    return { url, title, headers: {} };
  }).filter(Boolean);
  return { brand: 'DL', urls: [], direct };
}

// Hôtes qu'on sait extraire : on les traite avant les autres pour ne pas dépasser la limite de 20 embeds.
// (Voe change souvent de domaine miroir : cette liste n'est qu'une heuristique.)
const KNOWN = /voe|uqload|vidmoly|sendvid|sibnet|dood|d0o0d|ds2play|vidhide|filelions|lulu|veev|streamtape|mixdrop/i;
const prioritize = (embeds) => [...embeds].sort((a, b) => KNOWN.test(b.url) - KNOWN.test(a.url));

module.exports = { parseFstream, parseWiflix, parseSwiftflow, parseImdb, movixDownload, prioritize };
