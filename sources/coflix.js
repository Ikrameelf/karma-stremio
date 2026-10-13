// sources/coflix.js
// Flux Coflix ajoutés aux titres Stremio normaux (IDs IMDb), comme Movix. Node 18+.

const { playable } = require('./proxy');
const { resolveEmbed } = require('./extractors');

const BASE = 'https://coflix.wiki';
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const EXTRACT_TIMEOUT = 8000; // avant : 18000 (Stremio abandonnait avant la fin)
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

async function get(url, { method = 'GET', ajax = false, referer = BASE + '/' } = {}) {
  const r = await fetch(url, {
    method,
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Referer: referer,
      ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('délai dépassé')), ms))]);

const decode = (s = '') =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

const norm = (s = '') =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, 'et').replace(/[^a-z0-9]+/g, ' ').trim();

const stripSeason = (n) => n.replace(/\s*-?\s*saison\s*\d+.*$/i, '');

// Cartes de la page de recherche : { slug, name, lang }
function parseList(html) {
  const out = new Map();
  for (const c of html.split(/<div class="item">/).slice(1)) {
    const a = c.match(/<a\b[^>]*class="name d-title"[^>]*>([^<]*)<\/a>/i);
    if (!a) continue;
    const href = (a[0].match(/href="([^"]+)"/) || [])[1] || '';
    const slug = (href.match(/\/film\/([^\/?#"]+)/) || [])[1];
    if (!slug || out.has(slug)) continue;
    const lang = (c.match(/class="version">([^<]*)</) || [])[1] || (slug.match(/-(vostfr|vf)$/i) || [])[1] || '';
    out.set(slug, { slug, name: decode(a[1]), lang: lang.toUpperCase() });
  }
  return [...out.values()];
}

// ---------- IMDb -> titres (via TMDB, en français puis titre original) ----------

const titleCache = new Map();
async function titlesFor(imdb, kind) {
  const key = `${imdb}:${kind}`;
  if (titleCache.has(key)) return titleCache.get(key);
  const r = await fetch(
    `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_KEY}&external_source=imdb_id&language=fr-FR`
  );
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
  const d = await r.json();
  const x = ((kind === 'movie' ? d.movie_results : d.tv_results) || [])[0];
  const titles = x
    ? [...new Set([x.title || x.name, x.original_title || x.original_name].filter(Boolean))]
    : [];
  if (titles.length) titleCache.set(key, titles);
  return titles;
}

// ---------- recherche sur Coflix ----------

async function findCandidates(titles, kind, season) {
  const wanted = new Set(titles.map(norm));
  for (const t of titles) {
    let items = [];
    try {
      items = parseList(await get(`${BASE}/filter?keyword=${encodeURIComponent(t)}`));
    } catch (e) {
      console.error('[coflix] recherche échouée', t, e.message);
      continue;
    }
    const ok = items.filter((i) => {
      if (!/^(VF|VOSTFR|TRUEFRENCH)$/.test(i.lang)) return false;
      const m = i.name.match(/saison\s*(\d+)/i);
      if (kind === 'movie') {
        if (m) return false;
      } else if (!m || parseInt(m[1], 10) !== season) {
        return false;
      }
      return wanted.has(norm(stripSeason(i.name)));
    });
    if (ok.length) return ok.slice(0, 4);
  }
  return [];
}

async function episodeIdFor(slug, kind, episode) {
  const html = await get(`${BASE}/film/${slug}`);
  const movieId =
    (html.match(/id\s*:\s*"(\d+)"\s*,\s*type/) || html.match(/id="watch-page"[^>]*data-id="(\d+)"/) || [])[1];
  if (!movieId) return null;
  const j = JSON.parse(
    await get(`${BASE}/ajax/episode/list-episode?movieId=${movieId}`, { ajax: true, referer: `${BASE}/film/${slug}` })
  );
  const eps = [
    ...String(j.html || '').matchAll(/<a[^>]*class="ep-item[^"]*"[^>]*data-num="([^"]*)"[^>]*data-id="(\d+)"/g),
  ].map((m, i) => ({ num: parseInt(m[1], 10) || i + 1, id: m[2] }));
  if (!eps.length) return null;
  if (kind === 'movie') return eps[0].id;
  const hit = eps.find((e) => e.num === episode);
  return hit ? hit.id : null;
}

// ---------- flux ----------

async function streamFull(id, type) {
  if (!TMDB_KEY) {
    console.error('Coflix: définissez TMDB_API_KEY');
    return [];
  }
  const [imdb, s = '1', e = '1'] = id.split(':');
  const kind = type === 'movie' ? 'movie' : 'tv';
  const titles = await titlesFor(imdb, kind);
  if (!titles.length) return [];
  const cands = await findCandidates(titles, kind === 'movie' ? 'movie' : 'tv', parseInt(s, 10) || 1);
  console.log(`Coflix: ${cands.length} fiche(s) pour ${titles[0]}`);

  const perCand = await Promise.all(
    cands.map(async (c) => {
      try {
        const epId = await episodeIdFor(c.slug, kind, parseInt(e, 10) || 1);
        if (!epId) return [];
        const j = JSON.parse(
          await get(`${BASE}/ajax/episode/player?episode_id=${epId}`, {
            method: 'POST',
            ajax: true,
            referer: `${BASE}/film/${c.slug}/ep-${epId}`,
          })
        );
        if (!j.status || !Array.isArray(j.message)) return [];
        const lists = await Promise.all(
          j.message.map(async (m) => {
            const link = m.server_link && m.server_link.url ? m.server_link.url : m.server_link;
            if (typeof link !== 'string' || !/^https?:/.test(link)) return [];
            const host = new URL(link).hostname.replace(/^www\./, '');
            let links = [];
            try {
              links = await withTimeout(resolveEmbed(link, BASE + '/'), EXTRACT_TIMEOUT);
            } catch (err) {
              console.error('[coflix] extraction échouée', host, err.message);
            }
            console.log(`Coflix ${c.lang} ${host}: ${links.length} lien(s) vidéo`);
            if (links.length) {
              return links.map((l) =>
                playable({ name: `Coflix ${c.lang}`, title: `${host} · ${l.kind}`, url: l.url, headers: l.headers })
              );
            }
            return process.env.SHOW_BROWSER_LINKS
              ? [{ name: `Coflix ${c.lang}`, title: `${host} · navigateur`, externalUrl: link }]
              : [];
          })
        );
        return lists.flat();
      } catch (err) {
        console.error('[coflix] fiche échouée', c.slug, err.message);
        return [];
      }
    })
  );

  const seen = new Set();
  return perCand.flat().filter((x) => {
    const k = x.url || x.externalUrl;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Cache de 10 min, comme Movix (un résultat vide n'est jamais gardé).
const cache = new Map();
function stream(id, type) {
  let e = cache.get(id);
  if (!e || Date.now() - e.at > 10 * 60 * 1000) {
    e = { at: Date.now(), value: null };
    e.promise = streamFull(id, type)
      .then((v) => {
        if (v.length) e.value = v;
        else cache.delete(id);
        return v;
      })
      .catch((err) => {
        cache.delete(id);
        throw err;
      });
    cache.set(id, e);
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }
  return e.value ? Promise.resolve(e.value) : e.promise;
}

// ---------- routes de debug ----------

function registerDebug(app) {
  // /debug/coflix/search?q=cia
  app.get('/debug/coflix/search', async (req, res) => {
    try {
      res.json(parseList(await get(`${BASE}/filter?keyword=${encodeURIComponent(String(req.query.q || ''))}`)));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // /debug/coflix/stream?id=tt0944947:1:1&type=series
  app.get('/debug/coflix/stream', async (req, res) => {
    try {
      res.json(await streamFull(String(req.query.id || ''), String(req.query.type || 'series')));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // /debug/coflix/embed?u=https://voe.sx/e/xxxx : lecture d'un lecteur + début de sa page
  app.get('/debug/coflix/embed', async (req, res) => {
    try {
      const u = new URL(String(req.query.u || ''));
      if (!/^(voe\.sx|vidzy\.cc|trakx\.lol|uqload\.(vc|net))$/.test(u.hostname)) {
        return res.status(400).json({ error: 'hôte non autorisé' });
      }
      const links = await resolveEmbed(u.href, BASE + '/');
      const r = await fetch(u.href, { headers: { 'User-Agent': UA, Referer: BASE + '/' } });
      const html = await r.text();
      res.json({
        links,
        status: r.status,
        url_finale: r.url,
        taille: html.length,
        extrait: html.replace(/\s+/g, ' ').slice(0, 1500),
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
}

module.exports = {
  prefix: 'tt', // IDs IMDb, comme Movix
  types: ['movie', 'series'],
  stream,
  registerDebug,
};
