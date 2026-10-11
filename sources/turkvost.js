// Flux TurkVOST (avec sous-titres) pour les épisodes YoTurkish.
const axios = require('axios');
const { playable, proxyUrl } = require('./proxy');

const BASE = 'https://turkvost.fr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA, Referer: BASE + '/' } });
const MP4_RE = /https?:\/\/videos\.turkvost\.fr\/[^"'\s\\<>]+\.mp4[^"'\s\\<>]*/i;
const LANG3 = { fr: 'fra', en: 'eng', es: 'spa', ar: 'ara', tr: 'tur', de: 'deu', it: 'ita' };
const HEADERS = { Referer: BASE + '/', Origin: BASE, 'User-Agent': UA };

const slugify = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ı/g, 'i').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Corrections manuelles si le slug YoTurkish diffère de celui de TurkVOST : { 'slug-yoturkish': 'slug-turkvost' }
const ALIASES = {};

const slugCache = new Map();

async function exists(url) {
  try { await http.get(url, { responseType: 'text' }); return true; } catch { return false; }
}

async function findSlug(seriesPath) {
  const last = String(seriesPath || '').split('/').filter(Boolean).pop();
  if (!last) return null;
  const base = ALIASES[last] || slugify(last);
  if (slugCache.has(base)) return slugCache.get(base);
  const candidates = [...new Set([base, base.replace(/-(izle|vostfr|streaming)$/, '')])];
  let found = null;
  for (const c of candidates) {
    if (await exists(`${BASE}/serie/${c}-vostfr`)) { found = c; break; }
  }
  slugCache.set(base, found);
  return found;
}

// Extrait le tableau JSON après "name = [" en comptant les crochets (sans dépendre d'un ";").
function extractArray(html, name) {
  const i = html.search(new RegExp('\\b' + name + '\\s*=\\s*\\['));
  if (i < 0) return null;
  const start = html.indexOf('[', i);
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return html.slice(start, k + 1); }
  }
  return null;
}

// La page contient : var allTracks = [{"srclang":"fr","src":"https://.../xxx_fr.vtt?v=..."}, ...]
function parseSubtitles(html) {
  const raw = extractArray(html, 'allTracks');
  if (!raw) { console.log('TurkVOST : allTracks introuvable'); return []; }
  let tracks;
  try { tracks = JSON.parse(raw); }
  catch (e) { console.log('TurkVOST : allTracks illisible :', e.message, raw.slice(0, 200)); return []; }
  return tracks
    .filter((t) => t && t.src && t.srclang)
    .map((t) => {
      const url = new URL(t.src, BASE).href;
      return {
        id: `turkvost-${t.srclang}`,
        lang: LANG3[t.srclang] || t.srclang,
        url: proxyUrl(url, HEADERS) || url,
      };
    });
}

async function findStreams(seriesPath, epNum) {
  if (!seriesPath || !epNum) return [];
  const slug = await findSlug(seriesPath);
  if (!slug) return [];
  const epUrl = `${BASE}/serie/${slug}/episode-${epNum}-vostfr`;
  let html;
  try { html = (await http.get(epUrl, { responseType: 'text' })).data; }
  catch (e) { console.log(`TurkVOST ${epUrl} : ${e.response ? 'HTTP ' + e.response.status : e.message}`); return []; }

  const m = html.match(MP4_RE);
  if (!m) { console.log(`TurkVOST ${epUrl} : aucun MP4 trouvé`); return []; }
  const url = m[0].replace(/&amp;/g, '&');

  const stream = playable({ name: 'TurkVOST', title: 'TurkVOST VOSTFR (MP4)', url, headers: HEADERS });
  const subtitles = parseSubtitles(html);
  if (subtitles.length) stream.subtitles = subtitles;
  console.log(`TurkVOST ${epUrl} : MP4 + ${subtitles.length} sous-titre(s)`);
  return [stream];
}

module.exports = { findStreams };
