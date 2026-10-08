const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const proxy = require('./sources/proxy');
// Chaque source exporte { prefix, types, stream } et, en option,
// { catalogId, catalogName, genres, catalog, meta }.
const sources = [
  require('./sources/yoturkish'),
  require('./sources/movix'),
  require('./sources/nowtv'),
  require('./sources/dailymotion')
];
console.log(
  '[KARMA] Sources chargées:',
  sources.map((s) => `${s.prefix}:${s.types.join(',')}`).join(' | ')
);
const withCatalog = sources.filter((s) => s.catalog);
const withMeta = sources.filter((s) => s.meta);
// On supprime les doublons de préfixes dans le manifest.
// Movix et NOW utilisent tous les deux "tt".
const streamPrefixes = [
  ...new Set(
    sources.map((s) => s.prefix)
  )
];
const metaPrefixes = [
  ...new Set(
    withMeta.map((s) => s.prefix)
  )
];
const manifest = {
  id: 'community.karma.stremio',
  version: '1.2.1',
  name: 'Karma',
  description:
    'Port Stremio de providers Cs-Karma (YoTurkish, Movix, NOW TV) + Dailymotion.',
  types: ['movie', 'series'],
  resources: [
    'catalog',
    {
      name: 'meta',
      types: ['series'],
      idPrefixes: metaPrefixes
    },
    {
      name: 'stream',
      types: ['movie', 'series'],
      idPrefixes: streamPrefixes
    }
  ],
  catalogs: withCatalog.map((s) => ({
    type: s.types[0],
    id: s.catalogId,
    name: s.catalogName,
    extra: s.genres
      ? [
          {
            name: 'genre',
            options: s.genres
          },
          {
            name: 'search'
          },
          {
            name: 'skip'
          }
        ]
      : [
          {
            name: 'search',
            isRequired: true
          }
        ]
  }))
};
const builder =
  new addonBuilder(manifest);
const byId = (list, id) =>
  list.find((s) =>
    id.startsWith(s.prefix)
  );
builder.defineCatalogHandler(
  async ({ id, extra }) => {
    const src =
      withCatalog.find(
        (s) => s.catalogId === id
      );
    if (!src) {
      return {
        metas: []
      };
    }
    try {
      return {
        metas:
          await src.catalog(
            extra || {}
          )
      };
    } catch (e) {
      console.error(
        'catalog',
        e.message
      );
      return {
        metas: []
      };
    }
  }
);
builder.defineMetaHandler(
  async ({ id }) => {
    const src =
      byId(withMeta, id);
    if (!src) {
      return {
        meta: null
      };
    }
    try {
      return {
        meta:
          await src.meta(id)
      };
    } catch (e) {
      console.error(
        'meta',
        e.message
      );
      return {
        meta: null
      };
    }
  }
);
builder.defineStreamHandler(
  async ({ type, id }) => {
    console.log(
      `[KARMA] STREAM reçu: type=${type} id=${id}`
    );
    /*
     * Plusieurs sources utilisent "tt".
     *
     * Exemple :
     *   tt19394272:1:1
     *
     * peut être testé par Movix ET NOW TV.
     */
    const matchingSources =
      sources.filter(
        (s) =>
          Array.isArray(s.types) &&
          s.types.includes(type) &&
          id.startsWith(s.prefix)
      );
    console.log(
      '[KARMA] Sources correspondantes:',
      matchingSources
        .map(
          (s) =>
            `${s.prefix} (${s.types.join(',')})`
        )
        .join(' | ') || 'AUCUNE'
    );
    if (!matchingSources.length) {
      return {
        streams: []
      };
    }
    const results =
      await Promise.allSettled(
        matchingSources.map(
          async (src) => {
            console.log(
              `[KARMA] Appel source: ${src.prefix}`
            );
            try {
              const result =
                await src.stream(
                  id,
                  type
                );
              console.log(
                `[KARMA] Réponse source ${src.prefix}: ${
                  Array.isArray(result)
                    ? result.length
                    : 'INVALIDE'
                } flux`
              );
              return result;
            } catch (e) {
              console.error(
                `[KARMA] ERREUR source ${src.prefix}:`,
                e.stack || e.message
              );
              throw e;
            }
          }
        )
      );
    const streams = [];
    for (const result of results) {
      if (
        result.status === 'fulfilled' &&
        Array.isArray(result.value)
      ) {
        streams.push(
          ...result.value
        );
      }
    }
    console.log(
      `[KARMA] Total flux retournés: ${streams.length}`
    );
    return {
      streams
    };
  }
);
const app =
  express();
app.get(
  '/proxy/:u/:h/:sig/:name',
  proxy.handler
);
app.use(
  '/',
  getRouter(
    builder.getInterface()
  )
);
const PORT =
  Number(process.env.PORT) || 7000;
app.listen(
  PORT,
  () =>
    console.log(
      `Addon prêt : http://127.0.0.1:${PORT}/manifest.json`
    )
);
