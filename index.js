// Un flux vidéo interrompu (téléphone qui ferme la lecture, serveur distant coupé) ne doit jamais faire tomber l'addon.
process.on('uncaughtException', (e) => console.error('uncaughtException', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e && e.message ? e.message : e));

const express = require('express');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const proxy = require('./sources/proxy');

// Chaque source exporte { prefix, types, stream } et, en option, { catalogId, catalogName, genres, catalog, meta }.
// Plusieurs sources peuvent partager le même préfixe (Movix et Coflix : IDs IMDb « tt ») : leurs flux sont fusionnés.
const sources = [
  require('./sources/yoturkish'),
  require('./sources/movix'),
  require('./sources/voirdrama'),
  require('./sources/coflix'),
];
const withCatalog = sources.filter((s) => s.catalog);
const withMeta = sources.filter((s) => s.meta);

const manifest = {
  id: 'community.karma.stremio',
  version: '1.2.0',
  name: 'Karma',
  description: 'Port Stremio de providers Cs-Karma (YoTurkish, Movix, Coflix).',
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

// Appelle toutes les sources dont le préfixe correspond à l'ID et fusionne leurs flux.
builder.defineStreamHandler(async ({ type, id }) => {
  const list = sources.filter((s) => id.startsWith(s.prefix));
  const results = await Promise.allSettled(
    list.map((s) =>
      Promise.race([
        s.stream(id, type),
        new Promise((ok) => setTimeout(() => ok([]), 25000)), // une source lente ne bloque pas les autres
      ])
    )
  );
  const streams = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') streams.push(...(r.value || []));
    else console.error('stream', list[i].prefix, r.reason && r.reason.message);
  });
  return { streams };
});

const app = express();

// Route temporaire : /dbg?u=<url coflix>&q=<regex>&m=POST affiche le code d'une page (ou les passages qui correspondent).
app.get('/dbg', async (req, res) => {
  try {
    const u = new URL(req.query.u);
    if (!u.hostname.endsWith('coflix.wiki')) return res.status(400).send('refusé');
    const r = await axios.request({
      url: u.href,
      method: req.query.m === 'POST' ? 'POST' : 'GET',
      timeout: 10000,
      responseType: 'text',
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        Referer: 'https://coflix.wiki/',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const html = String(r.data);
    let out = html;
    if (req.query.q) {
      const re = new RegExp(req.query.q, 'gi');
      const found = [];
      let m;
      while ((m = re.exec(html)) && found.length < 40) {
        found.push(html.slice(Math.max(0, m.index - 250), m.index + 250).replace(/\s+/g, ' '));
      }
      out = found.join('\n\n----------\n\n');
    }
    res.type('text/plain').send(out || 'aucune correspondance');
  } catch (e) {
    res.status(500).send(String(e.message));
  }
});

app.get('/proxy/:u/:h/:sig/:name', proxy.handler);
require('./sources/voirdrama').registerDebug(app);
require('./sources/coflix').registerDebug(app);

// Page de diagnostic : ouvrez /debug dans un navigateur pour voir l'état de l'addon.
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
    coflix_recherche: await probe('https://coflix.wiki/filter?keyword=cia'),
  });
});

app.use('/', getRouter(builder.getInterface()));
const PORT = Number(process.env.PORT) || 7000;
app.listen(PORT, () => console.log(`Addon prêt : http://127.0.0.1:${PORT}/manifest.json`));
