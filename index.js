// Un flux vidéo interrompu (téléphone qui ferme la lecture, serveur distant coupé) ne doit jamais faire tomber l'addon.
process.on('uncaughtException', (e) => console.error('uncaughtException', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e && e.message ? e.message : e));

const express = require('express');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const proxy = require('./sources/proxy');

// Une source qui ne se charge pas (fichier absent, erreur de syntaxe) est ignorée au lieu de faire planter l'addon.
const load = (path) => {
  try { return require(path); } catch (e) { console.error(`Source ignorée ${path} :`, e.message); return null; }
};

// Chaque source exporte { prefix, types, stream } et, en option, { catalogId, catalogName, genres, catalog, meta }.
const sources = [load('./sources/yoturkish'), load('./sources/movix'), load('./sources/nowtv')].filter(Boolean);
const typesOf = (s) => s.types || ['movie', 'series'];
const withCatalog = sources.filter((s) => s.catalog);
const withMeta = sources.filter((s) => s.meta);

const manifest = {
  id: 'community.karma.stremio',
  version: '1.2.0',
  name: 'Karma',
  description: 'Port Stremio de providers Cs-Karma (YoTurkish, Movix, NOW TV).',
  types: ['movie', 'series'],
  resources: [
    'catalog',
    { name: 'meta', types: ['series'], idPrefixes: [...new Set(withMeta.map((s) => s.prefix))] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: [...new Set(sources.map((s) => s.prefix))] },
  ],
  catalogs: withCatalog.map((s) => ({
    type: typesOf(s)[0],
    id: s.catalogId,
    name: s.catalogName,
    extra: [{ name: 'genre', options: s.genres }, { name: 'search' }, { name: 'skip' }],
  })),
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ id, extra }) => {
  const src = withCatalog.find((s) => s.catalogId === id);
  if (!src) return { metas: [] };
  try { return { metas: await src.catalog(extra || {}) }; }
  catch (e) { console.error('catalog', e.message); return { metas: [] }; }
});

builder.defineMetaHandler(async ({ id }) => {
  const src = withMeta.find((s) => id.startsWith(s.prefix));
  if (!src) return { meta: null };
  try { return { meta: await src.meta(id) }; }
  catch (e) { console.error('meta', e.message); return { meta: null }; }
});

// Les liens "navigateur" ne sont gardés que s'il n'y a aucun lien lisible directement (ou si SHOW_BROWSER_LINKS=1).
const finalize = (streams) =>
  streams.some((x) => x.url) && !process.env.SHOW_BROWSER_LINKS ? streams.filter((x) => !x.externalUrl) : streams;

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve([]), ms))]);

// Plusieurs sources peuvent partager le même préfixe (Movix et NOW TV utilisent tous deux les IDs IMDb "tt") :
// on interroge TOUTES celles qui correspondent et on fusionne les résultats.
builder.defineStreamHandler(async ({ type, id }) => {
  const matching = sources.filter((s) => id.startsWith(s.prefix) && typesOf(s).includes(type));
  const results = await Promise.all(matching.map((s) =>
    withTimeout(Promise.resolve().then(() => s.stream(id, type)), 20000)
      .catch((e) => { console.error('stream', s.prefix, e.message); return []; })
  ));
  return { streams: finalize(results.flat().filter(Boolean)) };
});

const app = express();
app.get('/proxy/:u/:h/:sig/:name', proxy.handler);

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
  let youtube = null;
  try { youtube = require('./sources/youtube').status(); } catch (e) { youtube = { erreur: e.message }; }
  const mem = process.memoryUsage();
  res.json({
    version: manifest.version,
    node: process.version,
    uptime_secondes: Math.round(process.uptime()),
    memoire_Mo: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    sources_chargees: sources.map((s) => s.prefix),
    cles: { TMDB_API_KEY: !!process.env.TMDB_API_KEY, YOUTUBE_API_KEY: !!process.env.YOUTUBE_API_KEY },
    youtube,
    yoturkish_catalogue: await probe('https://yoturkish.to/series/'),
    movix_address: await probe('https://movix.online/address.json'),
  });
});

// Teste un épisode YoTurkish sans passer par Stremio :
// /debug/yoturkish?url=https://yoturkish.to/hercai-episode-2/&serie=Hercai&ep=2
app.get('/debug/yoturkish', async (req, res) => {
  const src = sources.find((s) => s.prefix === 'yot:');
  if (!src) return res.json({ erreur: 'source YoTurkish non chargée' });
  let path;
  try { const u = new URL(String(req.query.url || '')); path = u.pathname + u.search; }
  catch { return res.json({ erreur: 'ajoutez ?url=<adresse de la page de l\'épisode>' }); }
  const t = Date.now();
  try {
    // &serie=<nom de la série>&ep=<numéro> : permet de tester aussi YouTube et Dailymotion.
    const enc = (v) => Buffer.from(v).toString('base64url');
    let id = 'yot:ep:' + enc(path);
    if (req.query.serie && req.query.ep) id += '.' + enc(`${req.query.serie}|${parseInt(req.query.ep, 10) || 1}`);
    const streams = await src.stream(id, 'series');
    const describe = (x) => ({
      type: x.url ? 'DIRECT' : x.ytId ? 'YOUTUBE' : 'NAVIGATEUR',
      name: x.name, title: x.title,
      lien: String(x.url || x.externalUrl || x.ytId || '').slice(0, 140),
    });
    res.json({ duree_ms: Date.now() - t, recu_de_la_source: streams.map(describe), envoye_a_stremio: finalize(streams).map(describe) });
  } catch (e) {
    res.json({ duree_ms: Date.now() - t, erreur: e.message });
  }
});

app.use('/', getRouter(builder.getInterface()));
const PORT = Number(process.env.PORT) || 7000;
app.listen(PORT, () => console.log(`Addon prêt : http://127.0.0.1:${PORT}/manifest.json`));
