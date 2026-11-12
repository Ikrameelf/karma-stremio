// Flux TurkVOST (avec sous-titres) pour les épisodes YoTurkish.
// Version diagnostic : chaque abandon est maintenant écrit dans les logs, et un échec réseau n'est plus mis en cache.
const crypto = require('crypto');
const axios = require('axios');

const BASE = 'https://turkvost.fr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA, Referer: BASE + '/' } });
const MP4_RE = /https?:\/\/videos\.turkvost\.fr\/[^"'\s\\<>]+\.mp4[^"'\s\\<>]*/i;
// Stremio, Nuvio et les lecteurs Android utilisent plus volontiers les codes ISO 639-1.
const LANG2 = { fr: 'fr', en: 'en', es: 'es', ar: 'ar', tr: 'tr', de: 'de', it: 'it', ru: 'ru', pt: 'pt' };
const HEADERS = { Referer: BASE + '/', Origin: BASE, 'User-Agent': UA };

const slugify = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ı/g, 'i').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Corrections manuelles si le slug YoTurkish diffère de celui de TurkVOST : { 'slug-yoturkish': 'slug-turkvost' }
const ALIASES = {};

const slugCache = new Map();

// Retourne 'yes' (page trouvée), 'no' (404 : la page n'existe pas) ou 'error' (autre problème : réseau, 403, 5xx...).
async function check(url) {
  try {
    await http.get(url, { responseType: 'text' });
    return 'yes';
  } catch (e) {
    if (e.response && e.response.status === 404) return 'no';
    if (e.response && e.response.status === 429) {
      // Rate limit : on attend et on réessaie une fois.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await http.get(url, { responseType: 'text' });
        return 'yes';
      } catch (e2) {
        if (e2.response && e2.response.status === 404) return 'no';
        console.log(`TurkVOST ${url} : ${e2.response ? 'HTTP ' + e2.response.status + ' (serveur : ' + (e2.response.headers['server'] || '?') + ')' : e2.code || e2.message}`);
        return 'error';
      }
    }
    console.log(`TurkVOST ${url} : ${e.response ? 'HTTP ' + e.response.status + ' (serveur : ' + (e.response.headers['server'] || '?') + ')' : e.code || e.message}`);
    return 'error';
  }
}

async function findSlug(seriesPath) {
  const last = String(seriesPath || '').split('/').filter(Boolean).pop();
  if (!last) { console.log(`TurkVOST : chemin de série illisible (${seriesPath})`); return null; }
  const base = ALIASES[last] || slugify(last);
  if (slugCache.has(base)) return slugCache.get(base);
  const candidates = [...new Set([base, base.replace(/-(izle|vostfr|streaming)$/, '')])];
  const tryOnce = async () => {
    let found = null;
    let sawError = false;
    for (const c of candidates) {
      const r = await check(`${BASE}/serie/${c}-vostfr`);
      if (r === 'yes') { found = c; break; }
      if (r === 'error') sawError = true;
    }
    return { found, sawError };
  };
  let { found, sawError } = await tryOnce();
  // En cas de 429 (rate limit), on attend un peu et on réessaie une fois.
  if (!found && sawError) {
    await new Promise((r) => setTimeout(r, 2000));
    ({ found, sawError } = await tryOnce());
  }
  if (found) slugCache.set(base, found);
  else if (!sawError) slugCache.set(base, null); // on ne mémorise l'absence que si le site a répondu 404
  if (!found) console.log(`TurkVOST : série introuvable pour « ${last} » (essais : ${candidates.join(', ')})${sawError ? ' — erreur réseau, pas de mise en cache' : ''}`);
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
      // Identifiant unique par fichier : évite qu'un lecteur réutilise le
      // sous-titre d'un autre épisode qui porterait le même id (turkvost-fr).
      const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
      return {
        id: `turkvost-${t.srclang}-${key}`,
        lang: LANG2[String(t.srclang).toLowerCase()] || t.srclang,
        // URL directe du CDN TurkVOST : CORS *, aucun Referer requis et pas de
        // réveil du service Render (source de délais et d'échecs silencieux).
        url,
      };
    });
}

// Récupère uniquement les sous-titres d'un épisode. Utilisé en repli par le
// handler /subtitles quand l'extraction des flux n'a rien renvoyé.
async function findSubtitles(seriesPath, epNum) {
  if (!seriesPath || !epNum) return [];
  const slug = await findSlug(seriesPath);
  if (!slug) return [];
  const epUrl = `${BASE}/serie/${slug}/episode-${epNum}-vostfr`;
  try {
    const html = (await http.get(epUrl, { responseType: 'text' })).data;
    const subtitles = parseSubtitles(html);
    console.log(`TurkVOST ${epUrl} : ${subtitles.length} sous-titre(s) (repli)`);
    return subtitles;
  } catch (e) {
    console.log(`TurkVOST sous-titres ${epUrl} : ${e.response ? 'HTTP ' + e.response.status : e.message}`);
    return [];
  }
}

async function findStreams(seriesPath, epNum) {
  if (!seriesPath || !epNum) { console.log(`TurkVOST : série ou numéro d'épisode manquant (${seriesPath}, ${epNum})`); return []; }
  const slug = await findSlug(seriesPath);
  if (!slug) return [];
  const epUrl = `${BASE}/serie/${slug}/episode-${epNum}-vostfr`;
  let html;
  try { html = (await http.get(epUrl, { responseType: 'text' })).data; }
  catch (e) { console.log(`TurkVOST ${epUrl} : ${e.response ? 'HTTP ' + e.response.status : e.message}`); return []; }

  const m = html.match(MP4_RE);
  if (!m) {
    const wall = /ACC[ÈE]S VIP|CONNEXION REQUISE/i.test(html);
    console.log(`TurkVOST ${epUrl} : aucun MP4 trouvé${wall ? ' (la page affiche un mur VIP / connexion)' : ''}`);
    return [];
  }
  const url = m[0].replace(/&amp;/g, '&');
  try {
    const head = await http.head(url, { headers: HEADERS });
    const mb = Number(head.headers['content-length']) / 1048576;
    console.log(`TurkVOST taille : ${mb.toFixed(0)} Mo`);
  } catch (e) { console.log('TurkVOST taille indisponible :', e.response ? 'HTTP ' + e.response.status : e.message); }

  // On évite le proxy Render (qui se suspend) : le MP4 est lisible directement,
  // et on transmet les headers nécessaires au lecteur via proxyHeaders.
  const stream = {
    name: 'TurkVOST',
    title: 'VOSTFR + sous-titres (MP4)',
    url,
    behaviorHints: { notWebReady: true, proxyHeaders: { request: HEADERS } },
  };
  const subtitles = parseSubtitles(html);
  if (subtitles.length) stream.subtitles = subtitles;
  console.log(`TurkVOST ${epUrl} : MP4 + ${subtitles.length} sous-titre(s)`);
  return [stream];
}

module.exports = { findStreams, findSubtitles };
