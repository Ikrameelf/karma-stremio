// sources/voirdrama.js
// Source Voirdrama (site WordPress / thème Madara) pour l'addon karma.
// Nécessite Node 18+ (fetch global). Format CommonJS.

const { playable } = require('./proxy'); // relais vidéo existant (Referer/Origin)
const tmdb = require('./tmdb'); // enrichissement des fiches (comme pour YoTurkish)

const BASE = 'https://voirdrama.to';
const HOSTS_OK = ['voirdrama.to', 'voembed.net']; // utilisé seulement par les routes de debug
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const PAGE_SIZE = 16; // nombre de séries par page sur l'accueil
const PUBLIC = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

// Le site bloque l'affichage de ses images ailleurs (HTTP 403 sans Referer) :
// les affiches passent par la route /voirdrama-img de l'addon, qui envoie le bon Referer.
const imgCache = new Map(); // images déjà récupérées (évite de redemander au site)
const proxiedImg = (u, fallback) => {
  if (!u || !PUBLIC) return u;
  const payload = fallback && fallback !== u ? `${u}|${fallback}` : u; // grande image | miniature
  return `${PUBLIC}/voirdrama-img/${Buffer.from(payload).toString('base64url')}.jpg`;
};

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

// Cherche la meilleure URL d'image dans une balise <img> (gère le lazy-loading et srcset)
function imgUrl(tag) {
  const attr = (n) => (tag.match(new RegExp(`\\s${n}="([^"]+)"`, 'i')) || [])[1];
  const srcset = attr('data-srcset') || attr('srcset');
  const cands = [
    attr('data-src'), attr('data-lazy-src'), attr('data-original'), attr('data-cfsrc'),
    srcset && srcset.split(',').pop().trim().split(/\s+/)[0],
    attr('src'),
  ];
  for (const c of cands) {
    if (!c || /^data:/i.test(c)) continue;
    try {
      return new URL(decode(c), BASE).href;
    } catch (_) {}
  }
  return undefined;
}

function parseList(html) {
  const out = new Map();
  const re =
    /<h3[^>]*>\s*<a[^>]+href="https?:\/\/voirdrama\.to\/drama\/([^\/"]+)\/?"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1];
    if (out.has(slug)) continue;
    const before = html.slice(Math.max(0, m.index - 2500), m.index);
    const tags = [...before.matchAll(/<img\b[^>]*>/gi)].map((t) => t[0]);
    let poster;
    let thumb;
    for (let i = tags.length - 1; i >= 0 && !thumb; i--) thumb = imgUrl(tags[i]); // la plus proche du titre
    poster = bigPoster(thumb);
    out.set(slug, { slug, name: decode(m[2]), poster, thumb });
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
    poster: proxiedImg(i.poster, i.thumb),
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

  // genres du site : uniquement dans le bloc de la fiche (le menu contient tous les genres)
  const gBlock = (html.match(/genres-content[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  const genres = [
    ...new Set([...gBlock.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((m) => decode(m[1]))),
  ];
  const poster = proxiedImg(bigPoster(metaTag(html, 'og:image')));

  // tmdb.enrich complète la fiche ; renvoie la fiche du site telle quelle en cas de problème
  return tmdb.enrich({
    id,
    type: 'series',
    name: (metaTag(html, 'og:title') || slug).replace(/\s*[-–|]\s*Voirdrama.*$/i, ''),
    poster,
    background: poster,
    description: metaTag(html, 'og:description'),
    genres: genres.length ? genres : undefined,
    videos: eps.map((e) => ({
      id: `voirdrama:${slug}:${e.ep}`,
      title: `Épisode ${e.num} (${e.lang.toUpperCase()})`,
      season: both && e.lang === 'vf' ? 2 : 1,
      episode: e.num,
      thumbnail: poster, // repli si TMDB n'a pas d'image pour l'épisode
      released: new Date(Date.UTC(2000, 0, e.num)).toISOString(),
    })),
  });
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
  return [...set].filter((u) => /^https?:/.test(u) && !/disqus|facebook|google|twitter|wp-json|oembed/i.test(u));
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

  // Affiches : /voirdrama-img/<url[|repli] en base64url>.jpg (uniquement les images de voirdrama.to)
  app.get('/voirdrama-img/:id', async (req, res) => {
    try {
      const id = req.params.id.replace(/\.\w+$/, '');
      const send = (img) => {
        res.set('Content-Type', img.type);
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Access-Control-Allow-Origin', '*');
        res.send(img.buf);
      };
      if (imgCache.has(id)) return send(imgCache.get(id));

      const urls = Buffer.from(id, 'base64url').toString().split('|');
      for (const raw of urls) {
        let u;
        try { u = new URL(raw); } catch (_) { continue; }
        if (u.hostname !== 'voirdrama.to' || !u.pathname.startsWith('/wp-content/')) continue;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await fetch(u.href, {
              headers: { 'User-Agent': UA, Referer: BASE + '/', Accept: 'image/*,*/*;q=0.8' },
            });
            if (r.ok && /^image\//i.test(r.headers.get('content-type') || '')) {
              const img = { type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
              imgCache.set(id, img);
              if (imgCache.size > 150) imgCache.delete(imgCache.keys().next().value);
              return send(img);
            }
            console.error('[voirdrama] image', r.status, u.href);
            if (r.status === 404) break; // inutile de réessayer : passer à l'image de repli
          } catch (e) {
            console.error('[voirdrama] image erreur', e.message, u.href);
          }
          await new Promise((ok) => setTimeout(ok, 400));
        }
      }
      res.status(502).end();
    } catch (e) {
      res.status(500).end();
    }
  });

  // Diagnostic des affiches : /debug/voirdrama/catalog
  app.get('/debug/voirdrama/catalog', async (req, res) => {
    try {
      const items = parseList(await get(BASE + '/')).slice(0, 5);
      for (const it of items) {
        if (!it.poster) { it.test = 'aucune affiche trouvée dans le HTML'; continue; }
        try {
          // sans Referer, comme le ferait Stremio
          const r = await fetch(it.poster, { headers: { 'User-Agent': UA } });
          it.test = `HTTP ${r.status} ${r.headers.get('content-type') || ''}`;
          const r2 = await fetch(it.poster, { headers: { 'User-Agent': UA, Referer: BASE + '/' } });
          it.testAvecReferer = `HTTP ${r2.status} ${r2.headers.get('content-type') || ''}`;
          it.urlDansStremio = proxiedImg(it.poster, it.thumb);
        } catch (e) {
          it.test = 'erreur : ' + e.message;
        }
      }
      res.json(items);
    } catch (e) {
      res.status(500).json({ error: String(e) });
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
