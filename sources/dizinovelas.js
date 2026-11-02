// sources/dizinovelas.js
// Source Dizinovelas (site WordPress, thème ZetaFlix) pour l'addon karma.
// Catalogue + fiches de séries ; flux lisibles en interne uniquement (url directe ou P2P).
// Pas d'externalUrl : sur Android TV il n'y a pas de navigateur et l'appli plante.
//
// Chaîne de lecture (vue dans les logs) :
//   page /watch/1/ -> api.chainnetv.top/series.php?...web-player-2 -> https://dizall.playerp2p.live/#ID
// Le lecteur playerp2p.live charge la vidéo via son API (réponse chiffrée en hex).
//
// DEBUG = true : si aucun flux lisible n'est trouvé, l'addon affiche des lignes
// « DEBUG » dans Stremio dont le titre décrit ce qui a été trouvé. Ces lignes ne se
// lisent pas (URL factice) : elles servent seulement à lire le titre.

const crypto = require('crypto');
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

// Clé et IV AES-128-CBC supposés pour l'API des lecteurs de la famille playerp2p
// (issus de ma mémoire de ce type de lecteur, NON vérifiés : voir les lignes DEBUG).
const P2P_KEY = Buffer.from('kiemtienmua911ca');
const P2P_IV = Buffer.from('1234567890oiuytr');

// ---------- utilitaires ----------

async function get(url, { referer = BASE + '/', headers = {} } = {}) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Referer: referer,
      ...headers,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const err = new Error(`HTTP ${r.status} ${url}`);
    err.status = r.status;
    err.body = body.slice(0, 200);
    throw err;
  }
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

function debugItem(label, hints = [], snippet = '') {
  return { kind: 'page', url: label, hints, hosts: [], snippet: String(snippet).slice(0, 420), size: 0 };
}

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
      out.push(debugItem(n, ['erreur: ' + e.message.slice(0, 60)]));
    }
  }
  return out;
}

// ---------- lecteur playerp2p.live ----------

function p2pDecrypt(raw) {
  const hex = String(raw).trim().replace(/^"|"$/g, '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 32 !== 0) throw new Error('réponse non hexadécimale');
  const d = crypto.createDecipheriv('aes-128-cbc', P2P_KEY, P2P_IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
}

// Récupère les URL candidates (m3u8 / mp4 / champs source, hls, cf, file...) d'un texte JSON ou brut
function p2pCandidates(text, origin) {
  const urls = new Set();
  const add = (v) => {
    if (typeof v !== 'string') return;
    let s = v.replace(/\\\//g, '/').trim();
    if (s.startsWith('//')) s = 'https:' + s;
    else if (s.startsWith('/')) s = origin + s;
    if (/^https?:\/\//.test(s)) urls.add(s);
  };
  try {
    const walk = (o, key = '') => {
      if (typeof o === 'string') {
        if (/^(source|hls|cf|file|url|stream|link|src|playlist)$/i.test(key) || /\.(m3u8|mp4)/i.test(o)) add(o);
      } else if (Array.isArray(o)) o.forEach((x) => walk(x, key));
      else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => walk(v, k));
    };
    walk(JSON.parse(text));
  } catch (e) {
    /* pas du JSON : on tente la regex */
  }
  for (const m of String(text).matchAll(MEDIA_RE)) add(m[0]);
  return [...urls];
}

// Lit le script du lecteur pour trouver le vrai appel d'API et la clé de déchiffrement
async function inspectP2PBundle(pageUrl) {
  const out = [];
  try {
    const origin = new URL(pageUrl).origin;
    const html = await get(origin + '/', { referer: BASE + '/' });
    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => {
        try {
          return new URL(m[1], origin + '/').href;
        } catch (e) {
          return null;
        }
      })
      .filter((s) => s && s.startsWith(origin));
    out.push(debugItem('BUNDLE scripts', [], srcs.join(' | ')));

    for (const src of srcs.slice(0, 3)) {
      let js;
      try {
        js = await get(src, { referer: origin + '/' });
      } catch (e) {
        out.push(debugItem('BUNDLE erreur ' + src.slice(-40), [], e.message));
        continue;
      }
      const apis = [...new Set([...js.matchAll(/["'`](\/?api\/[A-Za-z0-9_\/.-]+)/g)].map((m) => m[1]))].slice(0, 10);
      out.push(debugItem('BUNDLE api (' + js.length + ' o)', [], apis.join(' | ') || '-'));

      const i = js.search(/api\/v1\/video/);
      if (i >= 0) out.push(debugItem('BUNDLE appel video', [], js.slice(Math.max(0, i - 120), i + 300)));

      const k = js.search(/createDecipheriv|CryptoJS|AES|decrypt/);
      if (k >= 0) out.push(debugItem('BUNDLE chiffrement', [], js.slice(Math.max(0, k - 150), k + 270)));

      const strs = [...new Set([...js.matchAll(/["']([A-Za-z0-9]{16})["']/g)].map((m) => m[1]))].slice(0, 8);
      out.push(debugItem('BUNDLE chaînes de 16 car.', [], strs.join(' | ') || '-'));
    }
  } catch (e) {
    out.push(debugItem('BUNDLE inspection ratée', [], e.message));
  }
  return out;
}

async function resolveP2P(pageUrl) {
  const out = [];
  let u;
  try {
    u = new URL(pageUrl);
  } catch (e) {
    return out;
  }
  const id = u.hash.replace(/^#/, '').split(/[&?]/)[0];
  if (!id) {
    out.push(debugItem("P2P : pas d'identifiant dans " + pageUrl));
    return out;
  }
  const origin = u.origin;
  const apis = [
    `${origin}/api/v1/video?id=${id}&w=1920&h=1080&r=${encodeURIComponent(BASE + '/')}`,
    `${origin}/api/v1/video?id=${id}&w=1920&h=1080&r=`,
    `${origin}/api/v1/video?id=${id}`,
  ];
  let ok = false;
  for (const api of apis) {
    try {
      const raw = await get(api, {
        referer: pageUrl,
        headers: { Origin: origin, Accept: '*/*' },
      });
      let text;
      try {
        text = p2pDecrypt(raw);
      } catch (e) {
        out.push(debugItem('P2P API ok mais déchiffrement raté : ' + e.message, [], String(raw).slice(0, 300)));
        continue;
      }
      const cands = p2pCandidates(text, origin);
      out.push(debugItem('P2P déchiffré, ' + cands.length + ' lien(s)', [], text.slice(0, 300)));
      for (const c of cands) out.push({ kind: 'direct', url: c, referer: origin + '/', origin });
      if (cands.length) {
        ok = true;
        break;
      }
    } catch (e) {
      out.push(debugItem('P2P API erreur ' + (e.status || '') + ' : ' + api.slice(origin.length, origin.length + 60), [], e.body || e.message));
    }
  }
  if (!ok) out.push(...(await inspectP2PBundle(pageUrl)));
  return out;
}

// ---------- flux Stremio ----------

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

      // lecteur playerp2p.live : on interroge son API
      const extra = [];
      for (const f of found) {
        if (f.kind === 'page' && /playerp2p\./i.test(f.url)) extra.push(...(await resolveP2P(f.url)));
      }
      found.push(...extra);

      const seen = new Set();
      for (const f of found) {
        const key = f.url || f.hash;
        if (seen.has(key)) continue;
        seen.add(key);
        if (f.kind === 'direct') {
          const hdr = { Referer: f.referer, 'User-Agent': UA };
          if (f.origin) hdr.Origin = f.origin;
          streams.push({
            name: 'Dizinovelas',
            title: /m3u8/i.test(f.url) ? 'Lecteur direct (HLS)' : 'Lecteur direct',
            url: f.url,
            behaviorHints: { notWebReady: true, proxyHeaders: { request: hdr } },
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
      debug.push(debugItem('lecteur chainnetv introuvable'));
      console.error('[dizinovelas] lecteur chainnetv introuvable sur', watch);
    }
  } catch (e) {
    console.error('[dizinovelas] stream échoué', e.message);
    debug.push(debugItem('erreur: ' + e.message.slice(0, 100)));
  }

  console.error('[dizinovelas] debug:', JSON.stringify(debug));

  // Aucun flux lisible : lignes DEBUG (non lisibles, juste pour lire le titre)
  if (DEBUG && !streams.length) {
    debug.slice(-7).forEach((d, i) => {
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
