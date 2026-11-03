// sources/animesama.js
// Source Anime-Sama (https://anime-sama.to) pour l'addon Karma.
// Catalogue, fiches et flux VOSTFR/VF. Node 18+ (fetch global), format CommonJS.

const { playable } = require('./proxy');
const { resolveEmbed } = require('./extractors');
const tmdb = require('./tmdb');

const BASE = 'https://anime-sama.to';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGE_SIZE = 48; // cartes par page sur le catalogue du site
const TTL = 10 * 60 * 1000; // fiche et flux gardés 10 minutes
const EXTRACT_TIMEOUT = 8000; // un lecteur qui ne répond pas ne doit pas bloquer les autres
const STREAM_DEADLINE = 15000; // marge sous le délai global de 25 s de index.js
const MAX_STREAMS = 6;

const GENRES = [
  'Action', 'Adolescence', 'Aliens / Extra-terrestres', 'Amitié', 'Amour', 'Apocalypse', 'Art',
  'Arts martiaux', 'Assassinat', 'Autre monde', 'Aventure', 'Combats', 'Comédie', 'Crime', 'Cyberpunk',
  'Danse', 'Démons', 'Détective', 'Donghua', 'Dragon', 'Drame', 'Ecchi', 'Ecole', 'Elfe', 'Enquête',
  'Famille', 'Fantastique', 'Fantasy', 'Fantômes', 'Futur', 'Gastronomie', 'Ghibli', 'Guerre',
  'Harcèlement', 'Harem', 'Harem inversé', 'Histoire', 'Historique', 'Homosexualité', 'Horreur',
  'Isekai', 'Jeunesse', 'Jeux', 'Jeux vidéo', 'Josei', 'Journalisme', 'Kaï', 'LGBT+', 'Mafia',
  'Magical girl', 'Magie', 'Maladie', 'Mariage', 'Mature', 'Mechas', 'Médiéval', 'Militaire',
  'Monde virtuel', 'Monstres', 'Musique', 'Mystère', 'Nekketsu', 'Ninjas', 'Nostalgie', 'Paranormal',
  'Philosophie', 'Pirates', 'Police', 'Politique', 'Post-apocalyptique', 'Pouvoirs psychiques',
  'Préhistoire', 'Prison', 'Psychologique', 'Quotidien', 'Religion', 'Réincarnation / Transmigration',
  'Romance', 'Samouraïs', 'School Life', 'Science-Fantasy', 'Science-fiction', 'Scientifique', 'Seinen',
  'Shôjo', 'Shôjo-Ai', 'Shônen', 'Shônen-Ai', 'Slice of Life', 'Société', 'Sport', 'Super pouvoirs',
  'Super-héros', 'Surnaturel', 'Survie', 'Survival game', 'Technologies', 'Thriller', 'Tournois',
  'Travail', 'Vampires', 'Vengeance', 'Voyage', 'Voyage temporel', 'Webcomic', 'Yakuza', 'Yaoi',
  'Yokai', 'Yuri',
];

// ---------- utilitaires ----------

async function get(url, { referer = BASE + '/', json = false } = {}) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
      Referer: referer,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return json ? r.json() : r.text();
}

const decode = (s = '') =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .trim();

const strip = (s = '') => decode(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return 'lecteur';
  }
};

const langLabel = (lang) =>
  ({ vostfr: 'VOSTFR', vf: 'VF', vf1: 'VF1', vf2: 'VF2', va: 'VA', vcn: 'VCN' }[lang] ||
    String(lang || '').toUpperCase());

// Les lecteurs encore utiles passent avant Sibnet (fermé) et les hôtes morts.
const playerRank = (u) => {
  const h = host(u);
  if (/ansembed|uqload|vidmoly|voe\.|sendvid/i.test(h)) return 0;
  if (/sibnet|oneupload|embed4me|player4me|myvi/i.test(h)) return 2;
  return 1;
};

function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
    }),
  ]);
}

function metaContent(html, name) {
  const direct = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"]*)["']`,
    'i'
  );
  const reverse = new RegExp(
    `<meta[^>]+content=["']([^"]*)["'][^>]+(?:name|property)=["']${name}["']`,
    'i'
  );
  const m = html.match(direct) || html.match(reverse);
  return m ? decode(m[1]) : undefined;
}

// ---------- catalogue ----------

function parseCards(html) {
  const out = [];
  const seen = new Set();
  for (const block of String(html).split('<div class="as-carte as-carte-oeuvre"').slice(1)) {
    const url = (block.match(/data-url="([^"]+)"/) || [])[1];
    if (!url || !/^\/catalogue\//.test(url)) continue;
    const slug = decodeURIComponent(url.replace(/^\/catalogue\//, '').replace(/\/.*$/, ''));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name = decode((block.match(/data-nom="([^"]*)"/) || [])[1] || slug);
    const poster =
      (block.match(/data-img="([^"]*)"/) || [])[1] ||
      (block.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    out.push({ slug, name, poster });
  }
  return out;
}

async function catalog(extra = {}) {
  const skip = parseInt(extra.skip, 10) || 0;
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const params = new URLSearchParams({ page: String(page) });
  params.append('type[]', 'Anime');
  if (extra.search) params.set('search', String(extra.search));
  if (extra.genre) params.append('genre[]', String(extra.genre));

  const data = await get(`${BASE}/catalogue/fragment.php?${params.toString()}`, {
    referer: `${BASE}/catalogue/`,
    json: true,
  });
  if (!data || !data.liste) return [];
  return parseCards(data.liste).map((i) => ({
    id: `animesama:${i.slug}`,
    type: 'series',
    name: i.name,
    poster: i.poster,
  }));
}

// ---------- fiche + saisons ----------

function parseGroups(html) {
  const panels = [];
  for (const m of html.matchAll(/panneauAnime\(\s*"([^"]*)"\s*,\s*"([^"]+)"\s*\)/g)) {
    const label = decode(m[1]);
    const panel = m[2].replace(/\/+$/, '');
    if (!label || label === 'nom' || panel === 'url') continue;
    const parts = panel.split('/');
    const lang = parts.pop();
    const base = parts.join('/');
    if (!base || !lang || /(^|\/)scan/i.test(base)) continue;
    panels.push({ label, base, lang });
  }

  // On garde les saisons classiques ; si l'œuvre n'en a aucune, on prend tous les panneaux vidéo.
  const main = panels.filter((p) => /^saison\d+$/.test(p.base));
  const chosen = main.length ? main : panels;

  const groups = new Map();
  for (const p of chosen) {
    let g = groups.get(p.base);
    if (!g) {
      g = { base: p.base, label: p.label, langs: [], start: 1, count: 0 };
      groups.set(p.base, g);
    } else if (/^saison\d+$/i.test(g.label) && p.label !== g.label) {
      g.label = p.label;
    }
    if (!g.langs.includes(p.lang)) g.langs.push(p.lang);

    const range = p.label.match(
      /\[(?:Episode|Épisode)\s*(\d+)\s*(?:à|a|–|-|\.\.\.)\s*(\d+)?\]/i
    );
    if (range) {
      const start = parseInt(range[1], 10);
      const end = range[2] ? parseInt(range[2], 10) : null;
      if (Number.isFinite(start)) g.start = start;
      if (Number.isFinite(end) && end >= start) g.count = end - start + 1;
    }
  }
  return groups;
}

function parseEpsJs(js) {
  return [...String(js).matchAll(/var\s+eps(\d+)\s*=\s*\[([\s\S]*?)\]\s*;/g)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) =>
      [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1].replace(/\\\//g, '/'))
    )
    .filter((list) => list.length);
}

async function episodesJs(slug, base, lang) {
  const referer = `${BASE}/catalogue/${encodeURIComponent(slug)}/${base}/${lang}/`;
  const r = await fetch(`${referer}episodes.js?x=${Date.now()}`, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Accept: '*/*',
      Referer: referer,
    },
  });
  if (!r.ok) return [];
  return parseEpsJs(await r.text());
}

async function fillCounts(slug, groups) {
  await Promise.all(
    [...groups.values()].map(async (g) => {
      if (g.count > 0) return;
      for (const lang of g.langs.length ? g.langs : ['vostfr']) {
        try {
          const arrays = await episodesJs(slug, g.base, lang);
          const len = arrays.length ? Math.max(...arrays.map((a) => a.length)) : 0;
          if (len > 0) {
            g.count = len;
            return;
          }
        } catch {
          /* langue absente : on essaie la suivante */
        }
      }
    })
  );
}

async function loadAnime(slug) {
  const html = await get(`${BASE}/catalogue/${encodeURIComponent(slug)}/`);

  const title =
    strip((html.match(/<h1 id="titreOeuvre"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) ||
    metaContent(html, 'og:title') ||
    slug;

  const poster =
    metaContent(html, 'og:image') ||
    (html.match(/class="oe-affiche"[\s\S]*?<img[^>]+src="([^"]+)"/i) || [])[1] ||
    (html.match(/id="imgOeuvre"[^>]+src="([^"]+)"/i) || [])[1] ||
    undefined;

  const background =
    (html.match(/class="oe-fond"[\s\S]*?<img[^>]+src="([^"]+)"/i) || [])[1] || poster;

  const description =
    strip((html.match(/<p id="synopsisText"[^>]*>([\s\S]*?)<\/p>/i) || [])[1]) ||
    metaContent(html, 'description');

  const genreBlock = (html.match(/class="oe-genres"([\s\S]*?)<\/div>/i) || [])[1] || '';
  const genres = [
    ...new Set(
      [...genreBlock.matchAll(/class="genre-pill"[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => strip(m[1]))
        .filter(Boolean)
    ),
  ];

  const metaBlock = (html.match(/<p class="oe-meta">([\s\S]*?)<\/p>/i) || [])[1] || '';
  const year = (strip(metaBlock).match(/\b(?:19|20)\d{2}\b/) || [])[0];

  const noteBlock =
    (html.match(/<span class="oe-note-quoi">Anime<\/span>([\s\S]{0,900}?)<\/a>/i) || [])[1] || '';
  const rating = ((noteBlock.match(/<b>([\d.,]+)<\/b>/) || [])[1] || '').replace(',', '.');

  const groups = parseGroups(html);
  await fillCounts(slug, groups);

  return {
    slug,
    title,
    poster,
    background,
    description,
    genres,
    year,
    rating,
    groups: [...groups.values()].filter((g) => g.count > 0),
  };
}

const animeCache = new Map();

async function animeData(slug) {
  const hit = animeCache.get(slug);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await loadAnime(slug);
  animeCache.set(slug, { at: Date.now(), data });
  if (animeCache.size > 100) animeCache.delete(animeCache.keys().next().value);
  return data;
}

const seasonNumber = (base) => {
  const m = String(base).match(/^saison(\d+)$/i);
  return m ? parseInt(m[1], 10) : 999;
};

async function meta(id) {
  const slug = String(id).split(':').slice(1).join(':');
  if (!slug) return null;
  const data = await animeData(slug);
  const groups = [...data.groups].sort((a, b) => seasonNumber(a.base) - seasonNumber(b.base));

  const videos = [];
  groups.forEach((g, i) => {
    for (let ep = g.start; ep < g.start + g.count; ep++) {
      videos.push({
        id: `animesama:${slug}:${g.base}:${ep}`,
        title: `Épisode ${ep}`,
        season: i + 1,
        episode: ep,
      });
    }
  });

  return tmdb.enrich({
    id,
    type: 'series',
    name: data.title,
    poster: data.poster,
    background: data.background || data.poster,
    description: data.description,
    genres: data.genres.length ? data.genres : undefined,
    releaseInfo: data.year || undefined,
    imdbRating: data.rating || undefined,
    videos,
  });
}

// ---------- flux ----------

async function streamFull(id, type) {
  if (type !== 'series') return [];

  const parts = String(id).split(':');
  if (parts.length < 4 || parts[0] !== 'animesama') return [];
  const [, slug, base] = parts;
  const ep = parseInt(parts[3], 10);
  if (!slug || !base || !Number.isFinite(ep)) return [];

  let data;
  try {
    data = await animeData(slug);
  } catch (e) {
    console.error('[animesama] fiche échouée', slug, e.message);
    return [];
  }

  const group = data.groups.find((g) => g.base === base);
  if (!group) return [];
  const index = ep - group.start;
  if (index < 0 || index >= group.count) return [];

  // Le site n'affiche pas toujours toutes les langues dans les panneaux : on tente aussi VF/VF2.
  const langs = [...new Set([...group.langs, 'vostfr', 'vf', 'vf2'])];
  const out = [];
  const seen = new Set();
  const deadline = Date.now() + STREAM_DEADLINE;

  for (const lang of langs) {
    if (Date.now() > deadline || out.length >= MAX_STREAMS) break;

    let arrays;
    try {
      arrays = await episodesJs(slug, base, lang);
    } catch {
      continue;
    }

    const players = [];
    for (const arr of arrays) {
      const embed = arr[index];
      if (embed && !seen.has(embed)) players.push(embed);
    }
    players.sort((a, b) => playerRank(a) - playerRank(b));

    let added = 0;
    for (const embed of players) {
      if (added >= 2 || Date.now() > deadline) break;
      seen.add(embed);

      let hits = [];
      try {
        hits = await withTimeout(resolveEmbed(embed, BASE + '/'), EXTRACT_TIMEOUT);
      } catch (e) {
        console.error('[animesama] extraction', host(embed), e.message);
        continue;
      }

      for (const h of hits) {
        if (added >= 2 || !h || !h.url) break;
        out.push(
          playable({
            name: 'Anime-Sama',
            title: `${langLabel(lang)} · ${host(embed)} · ${h.kind || 'vidéo'}`,
            url: h.url,
            headers: h.headers,
          })
        );
        added++;
      }
    }
  }

  console.log(`[animesama] ${id} : ${out.length} flux`);
  return out;
}

const cache = new Map();

function stream(id, type) {
  let e = cache.get(id);
  if (!e || Date.now() - e.at > TTL) {
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
    if (cache.size > 60) cache.delete(cache.keys().next().value);
  }
  return e.value ? Promise.resolve(e.value) : e.promise;
}

// ---------- diagnostic ----------

function registerDebug(app) {
  // /debug/animesama?slug=blue-box : fiche telle que comprise par l'addon
  app.get('/debug/animesama', async (req, res) => {
    try {
      res.json(await animeData(String(req.query.slug || 'blue-box')));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // /debug/animesama/stream?id=animesama:blue-box:saison1:1&type=series
  app.get('/debug/animesama/stream', async (req, res) => {
    try {
      res.json(await streamFull(String(req.query.id || ''), String(req.query.type || 'series')));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
}

module.exports = {
  prefix: 'animesama:',
  types: ['series'],
  catalogId: 'animesama',
  catalogName: 'Anime-Sama',
  genres: GENRES,
  catalog,
  meta,
  stream,
  registerDebug,
};
