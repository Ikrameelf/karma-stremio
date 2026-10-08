const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const proxy = require('./sources/proxy');

// Chaque source exporte { prefix, types, stream } et, en option, { catalogId, catalogName, genres, catalog, meta }.
const sources = [
  require('./sources/yoturkish'),
  require('./sources/movix'),
  require('./sources/nowtv'),
  require('./sources/dailymotion')
];

const withCatalog = sources.filter((s) => s.catalog);
const withMeta = sources.filter((s) => s.meta);

const manifest = {
  id: 'community.karma.stremio',
  version: '1.2.0',
  name: 'Karma',
  description: 'Port Stremio de providers Cs-Karma (YoTurkish, Movix, NOW TV) + Dailymotion.',
  types: ['movie', 'series'],
  resources: [
    'catalog',
    {
      name: 'meta',
      types: ['series'],
      idPrefixes: withMeta.map((s) => s.prefix)
    },
    {
      name: 'stream',
      types: ['movie', 'series'],
      idPrefixes: sources.map((s) => s.prefix)
    },
  ],
  catalogs: withCatalog.map((s) => ({
    type: s.types[0],
    id: s.catalogId,
    name: s.catalogName,
    // Sans genres (ex. Dailymotion) : catalogue visible uniquement via la recherche de Stremio.
    extra: s.genres
      ? [
          { name: 'genre', options: s.genres },
          { name: 'search' },
          { name: 'skip' }
        ]
      : [{ name: 'search', isRequired: true }],
  })),
};

const builder = new addonBuilder(manifest);

const byId = (list, id) =>
  list.find((s) => id.startsWith(s.prefix));

builder.defineCatalogHandler(async ({ id, extra }) => {
  const src = withCatalog.find((s) => s.catalogId === id);

  if (!src) {
    return { metas: [] };
  }

  try {
    return {
      metas: await src.catalog(extra || {})
    };
  } catch (e) {
    console.error('catalog', e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  const src = byId(withMeta, id);

  if (!src) {
    return { meta: null };
  }

  try {
    return {
      meta: await src.meta(id)
    };
  } catch (e) {
    console.error('meta', e.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  // Plusieurs sources peuvent utiliser le même préfixe IMDb "tt".
  // On interroge donc toutes les sources compatibles au lieu de prendre seulement la première.
  const matchingSources = sources.filter(
    (s) =>
      s.types.includes(type) &&
      id.startsWith(s.prefix)
  );

  if (!matchingSources.length) {
    return { streams: [] };
  }

  const results = await Promise.allSettled(
    matchingSources.map((src) => src.stream(id, type))
  );

  const streams = [];

  for (const result of results) {
    if (
      result.status === 'fulfilled' &&
      Array.isArray(result.value)
    ) {
      streams.push(...result.value);
    }
  }

  return { streams };
});

const app = express();

app.get('/proxy/:u/:h/:sig/:name', proxy.handler);

app.use('/', getRouter(builder.getInterface()));

const PORT = Number(process.env.PORT) || 7000;

app.listen(PORT, () =>
  console.log(
    `Addon prêt : http://127.0.0.1:${PORT}/manifest.json`
  )
);
