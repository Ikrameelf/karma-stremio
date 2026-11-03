// sources/viki.js
// Source Rakuten Viki : catalogue (tendances + recherche), fiches et épisodes.
// Les vidéos Viki sont protégées par DRM (Widevine) : aucun flux direct n'est extractible,
// la lecture renvoie donc un lien « Ouvrir sur Viki » vers la page officielle.
// API utilisée : endpoints publics du site (www.viki.com/v2/api et api.viki.io/v4), sans clé.

const tmdb = require('./tmdb');

const BASE = 'https://www.viki.com';
const API = 'https://api.viki.io/v4';
const LIST_ID = '7l'; // liste « tendances » de la page Explorer
const PAGE_SIZE = 24;
const LANG = 'fr';
const APP = '100000a';
const MAX_EPISODES = 200;
const CACHE_TTL = 10 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = new Map();

// Petit cache mémoire : évite de redemander la même fiche à chaque épisode ouvert.
function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.p;

  const entry = { at: Date.now(), p: load() };
  cache.set(key, entry);
  entry.p.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });

  if (cache.size > 300) {
    for (const [k, v] of cache) {
      if (Date.now() - v.at > CACHE_TTL) cache.delete(k);
    }
  }
  return entry.p;
}

async function getJson(url, referer = BASE + '/') {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.6',
      Referer: referer,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// ---------- utilitaires ----------

// Viki renvoie des dictionnaires par langue : on prend le français, sinon l'anglais.
function pick(map) {
  if (!map || typeof map !== 'object') return undefined;
  return map[LANG] || map.en || Object.values(map)[0];
}

const title = (item) => pick(item.titles) || 'Sans titre';
const description = (item) => pick(item.descriptions) || undefined;
const poster = (item) => item.images?.poster?.url;
const backdrop = (item) =>
  item.images?.billboards?.['16x9']?.[0]?.url || poster(item);

function toMeta(item) {
  return {
    id: `viki:serie:${item.id}`,
    type: 'series',
    name: title(item),
    poster: poster(item),
    background: backdrop(item),
    description: description(item),
  };
}

// ---------- catalogue ----------

async function catalog(extra = {}) {
  const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const search = String(extra.search || '').trim();

  const query = search
    ? new URLSearchParams({
        term: search,
        with_paging: 'true',
        per_page: String(PAGE_SIZE),
        page: String(page),
        il: LANG,
        cl: LANG,
        with_people: 'false',
      })
    : new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });

  const url = search
    ? `${BASE}/v2/api/search?${query}`
    : `${BASE}/v2/api/lists/${LIST_ID}?${query}`;

  const data = await getJson(url);
  const items = search ? data?.data?.items?.response : data?.data?.response;
  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => it && it.type === 'series' && it.blocked !== true)
    .map(toMeta);
}

// ---------- fiches ----------

const loadContainer = (seriesId) =>
  cached(`serie:${seriesId}`, () =>
    getJson(`${API}/containers/${encodeURIComponent(seriesId)}.json?app=${APP}`)
  );

async function loadEpisodes(seriesId) {
  return cached(`episodes:${seriesId}`, async () => {
    const out = [];

    for (let page = 1; page <= 5; page++) {
      const query = new URLSearchParams({
        app: APP,
        per_page: '100',
        page: String(page),
        direction: 'asc',
        sort: 'number',
        blocked: 'true',
      });
      const data = await getJson(
        `${API}/containers/${encodeURIComponent(seriesId)}/episodes.json?${query}`
      );

      const list = Array.isArray(data?.response) ? data.response : [];
      out.push(...list);

      if (!data?.more || !list.length || out.length >= MAX_EPISODES) break;
    }

    return out;
  });
}

async function meta(id) {
  const parts = String(id).split(':');
  if (parts.length < 3 || parts[1] !== 'serie') return null;

  const seriesId = parts.slice(2).join(':');
  const [container, episodes] = await Promise.all([
    loadContainer(seriesId),
    loadEpisodes(seriesId).catch((e) => {
      console.error('[viki] épisodes', e.message);
      return [];
    }),
  ]);
  if (!container) return null;

  const metaObj = {
    id,
    type: 'series',
    name: title(container),
    poster: poster(container),
    background: backdrop(container),
    description: description(container),
    videos: episodes
      .filter((ep) => ep && ep.id && Number(ep.number) > 0)
      .map((ep) => {
        const date = String(ep.created_at || '').slice(0, 10);
        return {
          id: `viki:ep:${ep.id}`,
          title: `Épisode ${ep.number}`,
          season: 1,
          episode: Number(ep.number),
          thumbnail: ep.images?.poster?.url,
          released: /^\d{4}-\d{2}-\d{2}$/.test(date)
            ? `${date}T00:00:00.000Z`
            : undefined,
        };
      }),
  };

  return tmdb.enrich(metaObj);
}

// ---------- flux ----------

async function videoWebUrl(videoId) {
  if (!/^\d+v$/.test(videoId)) return `${BASE}/videos/${videoId}`;

  const data = await cached(`video:${videoId}`, () =>
    getJson(`${API}/videos/${encodeURIComponent(videoId)}.json?app=${APP}`)
  ).catch(() => null);

  return data?.url?.web || `${BASE}/videos/${videoId}`;
}

async function stream(id) {
  const parts = String(id).split(':');
  if (parts.length < 3) return [];

  const key = parts.slice(2).join(':');

  try {
    if (parts[1] === 'ep') {
      return [
        {
          name: 'Viki',
          title: 'Ouvrir sur Viki (lecture sur le site)',
          externalUrl: await videoWebUrl(key),
        },
      ];
    }

    if (parts[1] === 'serie') {
      const container = await loadContainer(key).catch(() => null);
      return [
        {
          name: 'Viki',
          title: 'Ouvrir la fiche Viki',
          externalUrl: container?.url?.web || `${BASE}/tv/${key}`,
        },
      ];
    }
  } catch (e) {
    console.error('[viki] flux', e.message);
  }

  return [];
}

module.exports = {
  prefix: 'viki:',
  types: ['series'],
  catalogId: 'viki',
  catalogName: 'Viki',
  genres: [],
  catalog,
  meta,
  stream,
};
