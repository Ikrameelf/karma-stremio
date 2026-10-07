const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const proxy = require('./sources/proxy');

// Chaque source exporte { prefix, types, stream } et, en option, { catalogId, catalogName, genres, catalog, meta }.
const sources = [require('./sources/yoturkish'), require('./sources/movix')];
const withCatalog = sources.filter((s) => s.catalog);
const withMeta = sources.filter((s) => s.meta);

const manifest = {
  id: 'community.karma.stremio',
  version: '1.1.0',
  name: 'Karma',
  description: 'Port Stremio de providers Cs-Karma (YoTurkish, Movix).',
  types: ['movie', 'series'],
  resources: [
    'catalog',
    { name: 'meta', types: ['series'], idPrefixes: withMeta.map((s) => s.prefix) },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: sources.map((s) => s.prefix) },
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

builder.defineStreamHandler(async ({ type, id }) => {
  const src = byId(sources, id);
  if (!src) return { streams: [] };
  try { return { streams: await src.stream(id, type) }; }
  catch (e) { console.error('stream', e.message); return { streams: [] }; }
});

const app = express();
app.get('/proxy/:u/:h/:sig/:name', proxy.handler);
app.use('/', getRouter(builder.getInterface()));
const PORT = Number(process.env.PORT) || 7000;
app.listen(PORT, () => console.log(`Addon prêt : http://127.0.0.1:${PORT}/manifest.json`));
