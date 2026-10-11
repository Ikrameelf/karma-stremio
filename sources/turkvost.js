// Flux TurkVOST pour les épisodes YoTurkish.
const axios = require('axios');
const { playable } = require('./proxy');

const BASE = 'https://turkvost.fr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA, Referer: BASE + '/' } });
const MP4_RE = /https?:\/\/videos\.turkvost\.fr\/[^"'\s\\<>]+\.mp4[^"'\s\\<>]*/i;

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

async function findStreams(seriesPath, epNum) {
  if (!seriesPath || !epNum) return [];
  const slug = await findSlug(seriesPath);
  if (!slug) return [];
  const epUrl = `${BASE}/serie/${slug}/episode-${epNum}-vostfr`;
  let html;
  try { html = (await http.get(epUrl, { responseType: 'text' })).data; }
  catch (e) { console.log(`TurkVOST ${epUrl} : ${e.response ? 'HTTP ' + e.response.status : e.message}`); return []; }

  // DEBUG sous-titres (à retirer ensuite)
  const subHits = html.match(/.{0,100}(\.vtt|\.srt|<track|subtitle|captions|sous-titre).{0,150}/gi) || [];
  console.log('TurkVOST DEBUG subs :', JSON.stringify(subHits.slice(0, 8)));
  const scripts = html.match(/<script[^>]+src=["'][^"']+["']/gi) || [];
  console.log('TurkVOST DEBUG scripts :', JSON.stringify(scripts.slice(0, 15)));
  const noise = /sous-titres fran|hreflang|subtitleLanguage|plyr__captions|Captions —/i;
  const dyn = (html.match(/.{0,120}(fetch\(|XMLHttpRequest|\/api\/|textTracks|addTextTrack|VTTCue|\.php\?|subs?[\/_=]|"subs"|'subs'|tracks?\s*[:=]).{0,200}/gi) || []).filter((x) => !noise.test(x));
  console.log('TurkVOST DEBUG dyn :', JSON.stringify(dyn.slice(0, 12)));

  const m = html.match(MP4_RE);
  if (!m) { console.log(`TurkVOST ${epUrl} : aucun MP4 trouvé`); return []; }
  const url = m[0].replace(/&amp;/g, '&');
  return [playable({
    name: 'TurkVOST',
    title: 'TurkVOST VOSTFR (MP4)',
    url,
    headers: { Referer: BASE + '/', Origin: BASE, 'User-Agent': UA },
  })];
}

module.exports = { findStreams };
