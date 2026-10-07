// Un flux vidéo interrompu (téléphone qui ferme la lecture, serveur distant coupé) ne doit jamais faire tomber l'addon.
process.on('uncaughtException', (e) => console.error('uncaughtException', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e && e.message ? e.message : e));

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
  });
});

// Test ATV : télécharge une page depuis le serveur (donc avec l'IP de Render) et cherche où se cache la vidéo.
// Utilisation : /debug-atv  (page de la série), puis /debug-atv?url=<adresse d'un épisode sur atv.com.tr>
app.get('/debug-atv', async (req, res) => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const url = String(req.query.url || 'https://www.atv.com.tr/hercai');
  let host;
  try { host = new URL(url).hostname; } catch { return res.status(400).json({ erreur: 'URL invalide' }); }
  if (!/(^|\.)atv\.com\.tr$/i.test(host)) return res.status(400).json({ erreur: 'seules les adresses atv.com.tr sont acceptées' });
  try {
    const r = await axios.get(url, {
      timeout: 10000, maxContentLength: 3000000, validateStatus: () => true, responseType: 'text',
      headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9', Referer: 'https://www.atv.com.tr/' },
    });
    const html = String(r.data);
    const t = html.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    const uniq = (re, g = 0) => [...new Set([...t.matchAll(re)].map((m) => m[g]))].slice(0, 15);
    const around = (re) => [...t.matchAll(re)].slice(0, 6).map((m) => t.slice(Math.max(0, m.index - 80), m.index + 220).replace(/\s+/g, ' '));
    res.json({
      url, status: r.status, serveur: r.headers.server || null, octets: html.length,
      titre: (html.match(/<title>([^<]*)/i) || [])[1] || null,
      videos: uniq(/https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)[^"'\s\\<>]*/gi),
      iframes: uniq(/<iframe[^>]+src=["']([^"']+)["']/gi, 1),
      og_video: uniq(/property=["']og:video[^"']*["'][^>]+content=["']([^"']+)["']/gi, 1),
      json_ld: uniq(/"(?:contentUrl|embedUrl)"\s*:\s*"([^"]+)"/gi, 1),
      mots_cles: around(/(?:videoUrl|mediaUrl|streamUrl|hlsUrl|video_url|"hls"|"src"\s*:\s*"[^"]*(?:m3u8|mp4))/gi),
      scripts_lecteur: uniq(/<script[^>]+src=["']([^"']*(?:player|video|vod|media|stream)[^"']*)["']/gi, 1),
      liens_episodes: uniq(/href=["']((?:https?:\/\/www\.atv\.com\.tr)?\/[a-z0-9-]+\/[a-z0-9-]*bolum[a-z0-9-]*)["']/gi, 1),
      liens_hercai: uniq(/href=["']([^"']*hercai[^"']*)["']/gi, 1),
      blocage: (html.match(/(yurt\s?d[ıi]ş[ıi]|yurtdisi|ülkenizde|only available in turkey|geo[-_ ]?block|adblock[^<]{0,60})/gi) || []).slice(0, 5),
    });
  } catch (e) { res.json({ url, erreur: e.code || e.message }); }
});

app.use('/', getRouter(builder.getInterface()));
const PORT = Number(process.env.PORT) || 7000;
app.listen(PORT, () => console.log(`Addon prêt : http://127.0.0.1:${PORT}/manifest.json`));
