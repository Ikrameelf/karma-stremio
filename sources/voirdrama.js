// sources/voirdrama.js
// Source Voirdrama (site WordPress / thème Madara) pour l'addon karma.
// Nécessite Node 18+ (fetch global). Format CommonJS.

const { playable } = require('./proxy'); // relais vidéo existant (Referer/Origin)

const BASE = 'https://voirdrama.to';
const HOSTS_OK = ['voirdrama.to', 'voembed.net']; // utilisé seulement par les routes de debug
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const PAGE_SIZE = 16; // nombre de séries par page sur l'accueil

// ---------- utilitaires ----------

async function get(url, { referer = BASE + '/', method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(url, {
    method,
    body,
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Referer: referer,
      ...headers,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

const decode = (s = '') =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bigPoster = (u) => (u ? u.replace(/-\d+x\d+(\.\w+)$/, '$1') : u);

// ---------- catalogue ----------

function parseList(html) {
  const out = new Map();
  const re =
    /<h3[^>]*>\s*<a[^>]+href="https?:\/\/voirdrama\.to\/drama\/([^\/"]+)\/?"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1];
    if (out.has(slug)) continue;
    const before = html.slice(Math.max(0, m.index - 1500), m.index);
    const imgs = [
      ...before.matchAll(/<img[^>]+(?:data-src|src)="([^"]+\/wp-content\/uploads\/[^"]+)"/gi),
    ];
    out.set(slug, {
      slug,
      name: decode(m[2]),
      poster: imgs.length ? bigPoster(imgs[imgs.length - 1][1]) : undefined,
    });
  }
  return [...out.values()];
}

const GENRES = [
  'Action', 'Affaires', 'Amitié', 'Arts martiaux', 'Aventure', 'Comédie', 'Contexte scolaire',
  'Crime', 'Culinaire', 'Documentaire', 'Drame', 'Famille', 'Fantastique', 'Guerre', 'Historique',
  'Horreur', 'Jeunesse', 'Judiciaire', 'Mature', 'Médical', 'Mélodrame', 'Militaire', 'Musique',
  'Mystère', 'Politique', 'Psychologique', 'Romance', 'SF', 'Sitcom', 'Sport', 'Surnaturel',
  'Thriller', 'Tokusatsu', 'Vie quotidienne', 'Wuxia',
];
const genreSlug = (g) =>
  g.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '-');

// extra = { skip, search, genre } (chaînes, comme envoyé par Stremio)
async function catalog(extra = {}) {
  const skip = parseInt(extra.skip, 10) || 0;
  const search = extra.search;
  const p = Math.floor(skip / PAGE_SIZE) + 1;
  let url;
  if (search) {
    if (skip > 0) return []; // pas de pagination sur la recherche
    url = `${BASE}/?s=${encodeURIComponent(search)}&post_type=wp-manga`;
  } else if (extra.genre) {
    const root = `${BASE}/drama-genre/${genreSlug(extra.genre)}/`;
    url = p > 1 ? `${root}page/${p}/` : root;
  } else {
    url = p > 1 ? `${BASE}/page/${p}/` : BASE + '/';
  }
  const items = parseList(await get(url));
  return items.map((i) => ({
    id: `voirdrama:${i.slug}`,
    type: 'series',
    name: i.name,
    poster: i.poster,
  }));
}

// ---------- meta + épisodes ----------

function extractEpisodeLinks(html, slug) {
  const re = new RegExp(`href="https?://voirdrama\\.to/drama/${esc(slug)}/([^/"]+)/?"`, 'gi');
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(re)) {
    const ep = m[1];
    const mm = ep.match(/-(\d+)-(vostfr|vf)$/i);
    if (!mm || seen.has(ep)) continue;
    seen.add(ep);
    out.push({ ep, num: parseInt(mm[1], 10), lang: mm[2].toLowerCase() });
  }
  return out.sort((a, b) => a.num - b.num);
}

async function getEpisodes(slug, seriesHtml) {
  let links = extractEpisodeLinks(seriesHtml, slug);
  if (!links.length) {
    // thèmes Madara récents : la liste est chargée en AJAX
    try {
      const html = await get(`${BASE}/drama/${slug}/ajax/chapters/`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      links = extractEpisodeLinks(html, slug);
    } catch (_) {}
  }
  return links;
}

const metaTag = (html, prop) => {
  const m =
    html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${prop}"`, 'i'));
  return m ? decode(m[1]) : undefined;
};

async function meta(id) {
  const slug = id.split(':')[1];
  const html = await get(`${BASE}/drama/${slug}/`);
  const eps = await getEpisodes(slug, html);
  const langs = new Set(eps.map((e) => e.lang));
  const both = langs.size > 1; // VOSTFR en saison 1, VF en saison 2 pour éviter les doublons

  return {
    id,
    type: 'series',
    name: (metaTag(html, 'og:title') || slug).replace(/\s*[-–|]\s*Voirdrama.*$/i, ''),
    poster: bigPoster(metaTag(html, 'og:image')),
    description: metaTag(html, 'og:description'),
    videos: eps.map((e) => ({
      id: `voirdrama:${slug}:${e.ep}`,
      title: `Épisode ${e.num} (${e.lang.toUpperCase()})`,
      season: both && e.lang === 'vf' ? 2 : 1,
      episode: e.num,
      released: new Date(Date.UTC(2000, 0, e.num)).toISOString(),
    })),
  };
}

// ---------- extraction du lecteur ----------

// Décompresse le JS « packed » (eval(function(p,a,c,k,e,d){...})) souvent utilisé par les hébergeurs
function unpackAll(html) {
  let out = html;
  const re = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  for (const m of html.matchAll(re)) {
    let p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const a = +m[2];
    let c = +m[3];
    const k = m[4].split('|');
    const enc = (n) =>
      (n < a ? '' : enc(Math.floor(n / a))) +
      ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const dict = {};
    while (c--) dict[enc(c)] = k[c] || enc(c);
    out += '\n' + p.replace(/\b\w+\b/g, (w) => (dict[w] !== undefined ? dict[w] : w));
  }
  return out;
}

function findMediaUrls(text) {
  const clean = text.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  const found = [
    ...clean.matchAll(/https?:\/\/[^\s"'\\<>()]+?\.(?:m3u8|mp4)(?:\?[^\s"'\\<>()]*)?/gi),
  ].map((m) => m[0]);
  const uniq = [...new Set(found)];
  return uniq.sort((a, b) => (/\.m3u8/i.test(b) ? 1 : 0) - (/\.m3u8/i.test(a) ? 1 : 0));
}

// Retourne [{ url, referer }]
async function extractFromEmbed(embedUrl, depth = 1) {
  const html = await get(embedUrl, { referer: BASE + '/' });
  const urls = findMediaUrls(unpackAll(html));
  if (urls.length) return urls.map((url) => ({ url, referer: embedUrl }));

  if (depth > 0) {
    const inner = html.match(/<iframe[^>]+(?:src|data-src)="(https?:\/\/[^"]+)"/i);
    if (inner) return extractFromEmbed(decode(inner[1]), depth - 1);
  }
  return [];
}

function findEmbeds(pageHtml) {
  const set = new Set();
  for (const m of pageHtml.matchAll(/<iframe[^>]+(?:src|data-src)="([^"]+)"/gi)) set.add(decode(m[1]));
  for (const m of pageHtml.matchAll(/https?:\/\/[^\s"'<>]+\/embed[^\s"'<>]*/gi)) set.add(decode(m[0]));
  return [...set].filter((u) => /^https?:/.test(u) && !/disqus|facebook|google|twitter/i.test(u));
}

// ---------- flux ----------
async function stream(id, type) {
  const [, slug, ep] = id.split(':');
  const lang = /-vf$/i.test(ep) ? 'VF' : 'VOSTFR';
  const page = await get(`${BASE}/drama/${slug}/${ep}/`);
  const out = [];

  for (const embed of findEmbeds(page)) {
    let hits = [];
    try {
      hits = await extractFromEmbed(embed);
    } catch (e) {
      console.error('[voirdrama] extraction échouée', embed, e.message);
    }
    const host = new URL(embed).hostname;
    for (const h of hits) {
      const origin = new URL(h.referer).origin;
      out.push(
        playable({
          name: 'Voirdrama',
          title: `${lang} • ${host}`,
          url: h.url,
          headers: { Referer: h.referer, Origin: origin },
        })
      );
    }
  }
  return out;
}

// ---------- routes de debug (restreintes à voirdrama.to et voembed.net) ----------

function registerDebug(app) {
  // HTML brut : /debug/voirdrama?u=https://voembed.net/embed-xxxx.html
  app.get('/debug/voirdrama', async (req, res) => {
    try {
      const u = new URL(String(req.query.u || ''));
      if (!HOSTS_OK.includes(u.hostname)) return res.status(400).send('hôte non autorisé');
      res.type('text/plain').send(await get(u.href, { referer: String(req.query.ref || BASE + '/') }));
    } catch (e) {
      res.status(500).send(String(e));
    }
  });

  // Résultat de l'extraction : /debug/voirdrama/extract?u=https://voembed.net/embed-xxxx.html
  app.get('/debug/voirdrama/extract', async (req, res) => {
    try {
      const u = new URL(String(req.query.u || ''));
      if (!HOSTS_OK.includes(u.hostname)) return res.status(400).json({ error: 'hôte non autorisé' });
      res.json(await extractFromEmbed(u.href));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
}

module.exports = {
  prefix: 'voirdrama:',
  types: ['series'],
  catalogId: 'voirdrama',
  catalogName: 'Voirdrama',
  genres: GENRES,
  catalog,
  meta,
  stream,
  registerDebug,
};
