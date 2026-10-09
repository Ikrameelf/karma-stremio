// Un flux vidéo interrompu (téléphone qui ferme la lecture, serveur distant coupé) ne doit jamais faire tomber l'addon.
process.on('uncaughtException', (e) => console.error('uncaughtException', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e && e.message ? e.message : e));

const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const proxy = require('./sources/proxy');

// Chaque source exporte { prefix, types, stream } et, en option, { catalogId, catalogName, genres, catalog, meta }.
const sources = [require('./sources/yoturkish'), require('./sources/movix'), require('./sources/nuvio')];
const withCatalog = sources.filter((s) => s.catalog);
const withMeta = sources.filter((s) => s.meta);

const manifest = {
  id: 'community.karma.stremio',
  version: '1.2.0',
  name: 'Karma',
  description: 'Port Stremio de providers Cs-Karma (YoTurkish, Movix) + providers Nuvio.',
  types: ['movie', 'series'],
  resources: [
    'catalog',
    { name: 'meta', types: ['series'], idPrefixes: withMeta.map((s) => s.prefix) },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: [...new Set(sources.map((s) => s.prefix))] },
  ],
  catalogs: withCatalog.map((s) => ({
    type: s.types[0],
    id: s.catalogId,
    name: s.catalogName,
    extra: [{ name: 'genre', options: s.genres }, { name: 'search' }, { name: 'skip' }],
  })),
};

const builder = new addonBuilder(manifest);
const byId = (list, id) => list.find((s) => id.startsWith(s.prefix));

builder.defineCatalogHandler(async ({ id, extra }) => {
  const src = withCatalog.find((s) => s.catalogId === id);
  if (!src) return { metas: [] };
  try { return { metas: await src.catalog(extra || {}) }; }
  catch (e) { console.error('catalog', e.message); return { metas: [] }; }
});

builder.defineMetaHandler(async ({ id }) => {
  const src = byId(withMeta, id);
  if (!src) return { meta: null };
  try { return { meta: await src.meta(id) }; }
  catch (e) { console.error('meta', e.message); return { meta: null }; }
});

// Toutes les sources dont le préfixe correspond sont interrogées (Movix ET Nuvio pour les IDs "tt...").
builder.defineStreamHandler(async ({ type, id }) => {
  const matching = sources.filter((s) => id.startsWith(s.prefix));
  if (!matching.length) return { streams: [] };
  const lists = await Promise.all(matching.map(async (src) => {
    try { return await src.stream(id, type); }
    catch (e) { console.error('stream', e.message); return []; }
  }));
  return { streams: lists.flat() };
});

const app = express();
app.get('/proxy/:u/:h/:sig/:name', proxy.handler);
// Page de diagnostic : ouvrez /debug dans un navigateur pour voir l'état de l'addon.
const axios = require('axios');
app.get('/debug', async (req, res) => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const probe = async (url) => {
    try {
      const r = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': UA }, validateStatus: () => true, responseType: 'text' });
      const html = String(r.data);
      return { status: r.status, serveur: r.headers.server || null, octets: html.length, cartes: (html.match(/class="item/g) || []).length };
    } catch (e) { return { erreur: e.code || e.message }; }
  };
  const mem = process.memoryUsage();
  res.json({
    version: manifest.version,
    node: process.version,
    uptime_secondes: Math.round(process.uptime()),
    memoire_Mo: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    cles: { TMDB_API_KEY: !!process.env.TMDB_API_KEY, YOUTUBE_API_KEY: !!process.env.YOUTUBE_API_KEY },
    yoturkish_catalogue: await probe('https://yoturkish.to/series/'),
    movix_address: await probe('https://movix.online/address.json'),
    coflix: await probe('https://coflix.wiki/'),
  });
});

app.use('/', getRouter(builder.getInterface()));
const PORT = Number(process.env.PORT) || 7000;
app.listen(PORT, () => console.log(`Addon prêt : http://127.0.0.1:${PORT}/manifest.json`));
