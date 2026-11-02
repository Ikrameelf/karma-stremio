// sources/dizinovelas.js
// Source Dizinovelas (site WordPress, thème ZetaFlix) pour l'addon karma.
// Catalogue + fiches de séries ; flux lisibles en interne uniquement (url directe ou P2P).
// Pas d'externalUrl : sur Android TV il n'y a pas de navigateur et l'appli plante.
//
// DEBUG = true : si aucun flux lisible n'est trouvé, l'addon affiche des lignes
// « DEBUG » dans Stremio dont le titre décrit les pages traversées par le lecteur.
// Ces lignes ne se lisent pas (elles pointent vers une URL factice) : elles servent
// seulement à lire le titre. Mettre DEBUG = false une fois le problème réglé.

const tmdb = require('./tmdb');

const DEBUG = true;
const DEBUG_URL = 'https://karma-stremio.onrender.com/debug-dizinovelas';

const BASE = 'https://www.dizinovelas.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGE_SIZE = 30;

const GENRES = [
  'Action', 'Aventure', 'Comédie', 'Crime', 'Drame', 'Familial',
  'Fantastique', 'Mystère', 'Romance', 'Soap',
];

// ---------- utilitaires ----------

async function get(url, { referer = BASE + '/' } = {}) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Referer: referer,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

const decode = (s = '') =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '’')
    .trim();

const genreSlug = (g) =>
  String(g || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function metaTag(html, prop) {
  const re1 = new RegExp(`property=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`content=["']([^"']*)["'][^>]*property=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decode(m[1]) : undefined;
}

// ---------- catalogue ----------

function parseList(html) {
  const out = [];
  const parts = String(html).split('<div class="item-box"');
  for (const p of parts.slice(1)) {
    const urlm = p.match(/href="(https:\/\/www\.dizinovelas\.com\/series\/[^"]+)"/);
    if (!urlm) continue;
    const url = urlm[1];
    const sm = url.match(/\/series\/([^\/]+)/);
    if (!sm) continue;
    const slug = sm[1];
    const titlem = p.match(/<h3>(.*?)<\/h3>/s);
    const imgm = p.match(/data-original="([^"]+)"/);
    const title = titlem ? decode(titlem[1].replace(/<[^>]+>/g, '')) : slug;
    out.push({ slug, name: title || slug, poster: imgm ? imgm[1] : undefined });
  }
  const seen = new Set();
  return out.filter((i) => {
    if (seen.has(i.slug)) return false;
    seen.add(i.slug);
    return true;
  });
}

async function catalog(extra = {}) {
  const skip = parseInt(extra.skip, 10) || 0;
  const search = extra.search;
  const p = Math.floor(skip / PAGE_SIZE) + 1;
  let url;
  if (search) {
    if (skip > 0) return [];
    url = `${BASE}/?s=${encodeURIComponent(search)}`;
  } else if (extra.genre) {
    const root = `${BASE}/genre/${genreSlug(extra.genre)}/`;
    url = p > 1 ? `${root}page/${p}/` : root;
  } else {
    url = p > 1 ? `${BASE}/series/page/${p}/` : `${BASE}/series/`;
  }
  let html;
  try {
    html = await get(url);
  } catch (e) {
    console.error('[dizinovelas] catalogue échoué', e.message);
    return [];
  }
  const items = parseList(html);
  if (!items.length) {
    console.error('[dizinovelas] catalogue vide pour', url, '- taille page :', String(html).length);
  }
  return items.map((i) => ({
    id: `dizinovelas:serie:${i.slug}`,
    type: 'series',
    name: i.name,
    poster: i.poster,
  }));
}

// ---------- meta + épisodes ----------

async function meta(id) {
  const parts = String(id).split(':');
  if (parts.length < 3 || parts[1] !== 'serie') return null;
  const slug = parts.slice(2).join(':');
  const html = await get(`${BASE}/series/${slug}/`);

  const titleRaw =
    metaTag(html, 'og:title') ||
    ((html.match(/<title>(.*?)<\/title>/i) || [])[1] || slug);
  const name = decode(titleRaw)
    .replace(/^Regarder\s*:\s*/i, '')
    .replace(/\s*[-–|].*$/i, '')
    .trim() || slug;

  const poster = metaTag(html, 'og:image');
  const description = metaTag(html, 'og:description');

  const epSlugs = [...new Set([...String(html).matchAll(/\/episodes\/([^"\/]+)/g)].map((m) => m[1]))];
  const seenEp = new Set();
  const eps = [];
  for (const es of epSlugs) {
    const m = es.match(/-saison-(\d+)-episode-(\d+)/i);
    if (!m) continue;
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    const epId = `dizinovelas:ep:${es}`;
    if (seenEp.has(epId)) continue;
    seenEp.add(epId);
    eps.push({ season, episode, id: epId });
  }
  eps.sort((a, b) => a.season - b.season || a.episode - b.episode);

  const metaObj = {
    id,
    type: 'series',
    name,
    poster,
    background: poster,
    description,
    videos: eps.map((e) => ({
      id: e.id,
      title: `Épisode ${e.episode}`,
      season: e.season,
      episode: e.episode,
    })),
  };
  return tmdb.enrich(metaObj);
}

// ---------- flux ----------

const MEDIA_RE = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
const MAGNET_RE = /magnet:\?xt=urn:btih:([a-fA-F0-9]{40})[^\s"'<>]*/gi;
const IFRAME_RE = /<iframe[^>]+src=["']([^"']+)["']/gi;
const HINT_RE =
  /atob\(|eval\(|webtorrent|\.torrent|magnet:|infohash|p2p|\.m3u8|\.mp4|jwplayer|hls|aes|crypto|fetch\(|xmlhttprequest|\$\.ajax|sources\s*:|file\s*:/gi;

// Résume une page pour le debug : mots-clés trouvés, hôtes des scripts, début du contenu
function describePage(url, html) {
  const hints = [...new Set([...html.matchAll(HINT_RE)].map((m) => m[0].toLowerCase()))].slice(0, 12);
  const hosts = [
    ...new Set(
      [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => {
        try {
          return new URL(m[1], url).host;
        } catch (e) {
          return '?';
        }
      })
    ),
  ].slice(0, 6);
  const snippet = html.replace(/\s+/g, ' ').slice(0, 220);
  return { kind: 'page', url, hints, hosts, snippet, size: html.length };
}

async function resolvePage(url, referer, depth = 0) {
  if (depth > 3) return [];
  const html = await get(url, { referer });
  const out = [describePage(url, html)];

  // 1) liens médias directs dans la page
  for (const m of html.matchAll(MEDIA_RE)) {
    out.push({ kind: 'direct', url: m[0].replace(/\\\//g, '/'), referer: url });
  }

  // 2) liens magnet (P2P)
  for (const m of html.matchAll(MAGNET_RE)) {
    out.push({ kind: 'magnet', hash: m[1].toLowerCase(), magnet: m[0] });
  }

  // 3) redirections JS ou iframes : on suit
  const next = [];
  const loc = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/);
  if (loc) next.push(loc[1]);
  for (const m of html.matchAll(IFRAME_RE)) next.push(m[1]);

  for (let n of next) {
    if (n.startsWith('//')) n = 'https:' + n;
    if (!/^https?:/.test(n)) continue;
    try {
      out.push(...(await resolvePage(n, url, depth + 1)));
    } catch (e) {
      out.push({ kind: 'page', url: n, hints: ['erreur: ' + e.message.slice(0, 60)], hosts: [], snippet: '', size: 0 });
    }
  }
  return out;
}

async function stream(id, type) {
  const parts = String(id).split(':');
  if (parts.length < 3 || parts[1] !== 'ep') return [];
  const slug = parts.slice(2).join(':');
  const watch = `${BASE}/episodes/${slug}/watch/1/`;
  const streams = [];
  const debug = [];
  try {
    const html = await get(watch);
    debug.push(describePage(watch, html));
    const m = html.match(/src='(https:\/\/api\.chainnetv\.top\/series\.php[^']*web-player-2[^']*)'/);
    if (m) {
      const chain = m[1].replace(/&amp;/g, '&');
      const found = await resolvePage(chain, watch);
      const seen = new Set();
      for (const f of found) {
        const key = f.url || f.hash;
        if (seen.has(key)) continue;
        seen.add(key);
        if (f.kind === 'direct') {
          streams.push({
            name: 'Dizinovelas',
            title: 'Lecteur direct',
            url: f.url,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: { request: { Referer: f.referer, 'User-Agent': UA } },
            },
          });
        } else if (f.kind === 'magnet') {
          const trackers = [...f.magnet.matchAll(/[?&]tr=([^&]+)/g)].map(
            (t) => 'tracker:' + decodeURIComponent(t[1])
          );
          streams.push({ name: 'Dizinovelas', title: 'P2P', infoHash: f.hash, sources: trackers });
        } else {
          debug.push(f);
        }
      }
    } else {
      debug.push({ kind: 'page', url: 'lecteur chainnetv introuvable', hints: [], hosts: [], snippet: '', size: 0 });
      console.error('[dizinovelas] lecteur chainnetv introuvable sur', watch);
    }
  } catch (e) {
    console.error('[dizinovelas] stream échoué', e.message);
    debug.push({ kind: 'page', url: 'erreur: ' + e.message.slice(0, 100), hints: [], hosts: [], snippet: '', size: 0 });
  }

  console.error('[dizinovelas] debug:', JSON.stringify(debug));

  // Aucun flux lisible : on affiche des lignes DEBUG (non lisibles, juste pour lire le titre)
  if (DEBUG && !streams.length) {
    debug.slice(0, 5).forEach((d, i) => {
      streams.push({
        name: `DEBUG ${i + 1}`,
        title:
          `${String(d.url).slice(0, 140)}\n` +
          `taille: ${d.size} | mots: ${(d.hints || []).join(', ') || '-'}\n` +
          `scripts: ${(d.hosts || []).join(', ') || '-'}\n` +
          `${d.snippet || ''}`,
        url: DEBUG_URL,
      });
    });
  }
  return streams;
}

module.exports = {
  prefix: 'dizinovelas:',
  types: ['series'],
  catalogId: 'dizinovelas',
  catalogName: 'Dizinovelas',
  genres: GENRES,
  catalog,
  meta,
  stream,
};
