// sources/elisasaddictions.js
const tmdb = require('./tmdb');
// Flux directs Elisa's Addictions (worker MP4) pour l'addon karma.
// Les URLs directes sont publiques mais leur chemin (dossier/abreviation) varie par serie.
// On les derive du nom de collection Wix (PascalCase) : dossier = nom avec espaces,
// abreviation = initiales (ou nom complet si un seul mot).

const SERIES = {
  'askintarifi': 'AskinTarifi',
  'reaksiyon-1': 'Reaksiyon',
  'erkenci-kus': 'ErkenciKus',
  'tatli-intikam': 'TatliIntikam',
  'adizehra': 'AdiZehra',
  'sol-yanim': 'SolYanim',
  'bayyanlis': 'BayYanlis',
  'kurulusosman': 'KurulusOsman',
  'yabani-1': 'Yabani',
  'atesbocegi': 'Atesbocegi',
  'hudutsuz-sevda': 'HudutsuzSevda',
  'guvercin-1': 'Guvercin',
  'siyah-inci': 'SiyahInci',
  'asklaftananlamaz': 'AskLaftanAnlamaz',
  'sen-cal-kapimi': 'SenCalKapimi',
  'senden-daha-guzel': 'SendenDahaGuzel',
  'hercai-1': 'Hercai',
  'her-yerde-sen': 'HerYerdeSen',
  'bahtoyunu': 'AskinTarifi1',
  'uyanis-buyuk-selcuklu': 'UyanisBuyukSelcuklu',
  'ada-masali': 'AdaMasali',
  'banasevmeyianlat': 'BanaSevmeyiAnlat',
  'alev-alev': 'AlevAlev',
  'meryem-1': 'Meryem',
  'muhtesem-ikili': 'MuhtesemIkili',
  'dolunay-1': 'Dolunay',
  'yalicapkini': 'YaliCapkini',
  'akinci': 'Akinci',
  'adimfarah': 'AdimFarah',
  'inadinaask': 'InadinaAsk',
  'carpisma-1': 'Carpisma',
  'birkucukgunisigi': 'BirKucukGunIsigi',
  'seref-meselesi': 'SerefMeselesi',
  'calikusu': 'Calikusu',
  'babamingunahlari': 'BabaminGunahlari1',
};

// Liens externes manuels : clé = "prefix:epNum", valeur = tableau d'URLs.
// Exemple : 'hercai-1:1': ['https://vidmoly.me/v/xxxx', 'https://mega.nz/file/...']
const EXTRA = {};

const FILES = {
  'askintarifi': 'AT',
  'reaksiyon-1': 'Reaksiyon',
  'erkenci-kus': 'EK',
  'tatli-intikam': 'TatliIntikam',
  'adizehra': 'AZ',
  'kurulusosman': 'KO',
  'yabani-1': 'Yabani',
  'atesbocegi': 'Atesbocegi',
  'hudutsuz-sevda': 'HudutsuzSevda',
  'guvercin-1': 'Guvercin',
  'siyah-inci': 'SiyahInci',
  'asklaftananlamaz': 'ALA',
  'sen-cal-kapimi': 'SCK',
  'hercai-1': 'Hercai',
  'her-yerde-sen': 'HYS',
  'uyanis-buyuk-selcuklu': 'UBS',
  'ada-masali': 'AdaMasali',
  'banasevmeyianlat': 'BSA',
  'alev-alev': 'AlevAlev',
  'meryem-1': 'Meryem',
  'muhtesem-ikili': 'MuhtesemIkili',
  'dolunay-1': 'Dolunay',
  'akinci': 'Akinci',
  'adimfarah': 'AF',
  'seref-meselesi': 'SerefMeselesi',
};

const CONFIG = {
  'askintarifi': { collection: 'AskinTarifi', pageRole: '79ddb6a5-3e42-4b31-ac5d-bf8ed8e95844', pageId: 'f3nba' },
  'reaksiyon-1': { collection: 'Reaksiyon', pageRole: '98ac1e9a-5809-4965-8082-a19db111834a', pageId: 'nn5w3' },
  'erkenci-kus': { collection: 'ErkenciKus', pageRole: '668da5d3-dd4c-4a3f-8392-b40772af311b', pageId: 'lh9tx' },
  'tatli-intikam': { collection: 'TatliIntikam', pageRole: '1a4a1319-e0bf-4bbf-afb7-793f4b1a87f7', pageId: 'q2adv' },
  'adizehra': { collection: 'AdiZehra', pageRole: '0fb8c238-48b2-4c91-b270-6237e1ab8b85', pageId: 'gjhou' },
  'kurulusosman': { collection: 'KurulusOsman', pageRole: '20728382-ab64-4260-9a26-01d5358e6f63', pageId: 'yp05z' },
  'yabani-1': { collection: 'Yabani', pageRole: 'c33dc499-3f13-4810-8637-aae8cf107699', pageId: 'pes9h' },
  'atesbocegi': { collection: 'Atesbocegi', pageRole: '1d4818f1-df20-414f-8222-16e40143ced3', pageId: 'na5be' },
  'hudutsuz-sevda': { collection: 'HudutsuzSevda', pageRole: 'f01cf80f-f00e-4de2-aad2-711ebdf7107f', pageId: 'pm1jx' },
  'guvercin-1': { collection: 'Guvercin', pageRole: '2e8833e7-78b7-4fd9-8d78-d1da1da0b2e0', pageId: 'o8ubc' },
  'siyah-inci': { collection: 'SiyahInci', pageRole: 'cf17f2e3-b3cf-4bc9-9de7-b19f744c922b', pageId: 'e8k5n' },
  'asklaftananlamaz': { collection: 'AskLaftanAnlamaz', pageRole: 'd5c029e8-41e4-4a79-9ceb-b28af28fe05f', pageId: 'm8qcy' },
  'sen-cal-kapimi': { collection: 'SenCalKapimi', pageRole: 'a44360b9-aa9f-46ee-96b5-1267d42e1de5', pageId: 'z754a' },
  'hercai-1': { collection: 'Hercai', pageRole: '4841b4f0-292d-469e-bba6-516b44f1d3ef', pageId: 'vxdn0' },
  'her-yerde-sen': { collection: 'HerYerdeSen', pageRole: '187cd386-29ef-41c7-88d7-530f4de6e82c', pageId: 'lx422' },
  'uyanis-buyuk-selcuklu': { collection: 'UyanisBuyukSelcuklu', pageRole: 'f21b114d-5844-4207-89c5-ab02e49e605a', pageId: 'gtj7m' },
  'ada-masali': { collection: 'AdaMasali', pageRole: 'f85b992b-a3d5-4dcb-a840-56afb2253b25', pageId: 'vwv9z' },
  'banasevmeyianlat': { collection: 'BanaSevmeyiAnlat', pageRole: '30078298-0867-4efc-a329-e3a3c3e06b90', pageId: 'zzsnt' },
  'alev-alev': { collection: 'AlevAlev', pageRole: 'f235cb6f-b45e-414a-af7c-40f8c6f8f068', pageId: 'jpuw7' },
  'meryem-1': { collection: 'Meryem', pageRole: 'b03d749d-f26c-4628-a8d5-d74aae3eb83f', pageId: 'pl64q' },
  'muhtesem-ikili': { collection: 'MuhtesemIkili', pageRole: '0a82640a-9c96-44b3-8c9a-94430bffe65e', pageId: 'd4j1u' },
  'dolunay-1': { collection: 'Dolunay', pageRole: '0614d736-bfd9-4778-8a02-a8ef675636be', pageId: 'gse51' },
  'akinci': { collection: 'Akinci', pageRole: '278990bf-eb7a-4ce3-ae4a-a3d96f106ae6', pageId: 'ck9rk' },
  'adimfarah': { collection: 'AdimFarah', pageRole: '7daa7ee7-58ee-4431-bb64-abd00e0ebb99', pageId: 'gwkru' },
  'seref-meselesi': { collection: 'SerefMeselesi', pageRole: '3a75f636-c538-4520-8b31-4fec124085ab', pageId: 'we8dl' },
  'calikusu': { collection: 'Calikusu', pageRole: '17f9374f-af47-4224-b575-55d3138e2c40', pageId: 'x82zq' },
  'bayyanlis': { collection: 'BayYanlis', pageRole: '1c09cec2-c8df-48e6-ba32-287a34c54fa6', pageId: 'whxbz' },
  'ada-masali': { collection: 'AdaMasali', pageRole: 'f85b992b-a3d5-4dcb-a840-56afb2253b25', pageId: 'vwv9z' },
  'inadinaask': { collection: 'InadinaAsk', pageRole: '5b827b61-0ac1-4a81-b04e-1248019df4b3', pageId: 'hdk1v' },
  'yabani-1': { collection: 'Yabani', pageRole: 'c33dc499-3f13-4810-8637-aae8cf107699', pageId: 'pes9h' },
  'siyah-inci': { collection: 'SiyahInci', pageRole: 'cf17f2e3-b3cf-4bc9-9de7-b19f744c922b', pageId: 'e8k5n' },
  'tatli-intikam': { collection: 'TatliIntikam', pageRole: '1a4a1319-e0bf-4bbf-afb7-793f4b1a87f7', pageId: 'q2adv' },
  'birkucukgunisigi': { collection: 'BirKucukGunIsigi', pageRole: 'e689db14-dc60-4ce2-9483-3f54cf32e308', pageId: 'niwhj' },
  'sol-yanim': { collection: 'SolYanim', pageRole: '545b6482-be7d-450c-982d-bb0aa3dffa5a', pageId: 'pxhr3' },
  'babamingunahlari': { collection: 'BabaminGunahlari1', pageRole: '27921c64-ae2d-4da2-8344-34887f14e3a6', pageId: 'b6efa' },
  'adimfarah': { collection: 'AdimFarah', pageRole: '7daa7ee7-58ee-4431-bb64-abd00e0ebb99', pageId: 'gwkru' },
  'askintarifi': { collection: 'AskinTarifi', pageRole: '79ddb6a5-3e42-4b31-ac5d-bf8ed8e95844', pageId: 'f3nba' },
  'carpisma-1': { collection: 'Carpisma', pageRole: 'ecbea425-0845-4443-9d68-5e65cb3b614a', pageId: 'eahtr' },
  'muhtesem-ikili': { collection: 'MuhtesemIkili', pageRole: '0a82640a-9c96-44b3-8c9a-94430bffe65e', pageId: 'd4j1u' },
  'erkenci-kus': { collection: 'ErkenciKus', pageRole: '668da5d3-dd4c-4a3f-8392-b40772af311b', pageId: 'lh9tx' },
};

function splitPascal(s) {
  return String(s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function folderAndAbbr(collection) {
  const words = splitPascal(collection);
  const folder = words.join(' ');
  const abbr = words.length === 1 ? words[0] : words.map((w) => w[0]).join('');
  return { folder, abbr };
}

function buildStreamUrl(prefix, collection, epNum) {
  const abbr = FILES[prefix] || collection;
  const words = splitPascal(collection);
  const folder = words.join(' ');
  const n = String(epNum).padStart(2, '0');
  const folderEnc = encodeURIComponent(folder).replace(/%20/g, '+');
  return `https://streaming.elisasaddictions.workers.dev/file/ElisasAddictions/${folderEnc}/${abbr}_VOSTFR_${n}.mp4`;
}

// ---------- Fetcher Wix (liens externes) ----------
const zlib = require('zlib');

function buildR(prefix, epSlug) {
  const cfg = CONFIG[prefix];
  if (!cfg) return null;
  const obj = {
    urlParams: { gridAppId: 'b48cb8d5-08c2-4016-a76e-04ed1f3ff931', viewMode: 'site' },
    body: {
      routerPrefix: '/' + prefix,
      config: { patterns: { '/{title}': { pageRole: cfg.pageRole, title: '{title}', config: { collection: cfg.collection, pageSize: 1, lowercase: true, seoV2: true } } } },
      pageRoles: { [cfg.pageRole]: { id: cfg.pageId } },
      requestInfo: { env: 'browser', formFactor: 'desktop' },
      routerSuffix: '/' + encodeURIComponent(epSlug),
      fullUrl: `https://www.elisasaddictions.fr/${prefix}/${epSlug}`,
      roleVariations: {},
    },
  };
  const json = JSON.stringify(obj);
  const gz = zlib.gzipSync(json);
  return gz.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function extractLinks(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach((n) => extractLinks(n, out)); return; }
  if (typeof node === 'object') {
    if (node.linkData && node.linkData.link && node.linkData.link.url) {
      out.push(node.linkData.link.url);
    }
    Object.values(node).forEach((v) => extractLinks(v, out));
  }
}

async function wixFetch(prefix, epNum) {
  const auth = (process.env.ELISA_AUTH || '').trim();
  const xsrf = (process.env.ELISA_XSRF || '').trim();
  const cookies = (process.env.ELISA_COOKIES || '').trim();
  if (!auth || !xsrf || !cookies) return [];
  const cfg = CONFIG[prefix];
  if (!cfg) return [];
  const epSlug = encodeURIComponent(`épisode-${String(epNum).padStart(2, '0')}`).replace(/%20/g, '%20');
  const r = buildR(prefix, `épisode-${String(epNum).padStart(2, '0')}`);
  if (!r) return [];
  try {
    const res = await fetch(`https://www.elisasaddictions.fr/_api/dynamic-pages-router/v1/pages?.r=${r}`, {
      headers: {
        'Authorization': auth,
        'X-XSRF-TOKEN': xsrf,
        'Cookie': cookies,
        'Content-Type': 'application/json',
        'Referer': `https://www.elisasaddictions.fr/${prefix}/%C3%A9pisode-${String(epNum).padStart(2, '0')}`,
      },
    });
    if (!res.ok) { console.log(`[elisa wix] HTTP ${res.status}`); return []; }
    const data = await res.json();
    const item = data && data.result && data.result.data && data.result.data.items && data.result.data.items[0];
    if (!item) return [];
    const out = [];
    // contenu21 = Abyss player
    if (typeof item.contenu21 === 'string' && item.contenu21.startsWith('http')) {
      out.push({ name: "Elisa's Addictions", title: 'Abyss', url: item.contenu21, behaviorHints: { notWebReady: true } });
    }
    // contenu3 = liens externes
    const links = [];
    extractLinks(item.contenu3, links);
    const seen = new Set();
    for (const u of links) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      let host = '';
      try { host = new URL(u).hostname; } catch { host = u; }
      out.push({ name: "Elisa's Addictions", title: host, url: u, behaviorHints: { notWebReady: true } });
    }
    // contenu2 = worker direct (déjà ajouté par stream, mais on le garde si présent)
    return out;
  } catch (e) {
    console.log('[elisa wix] erreur:', e.message);
    return [];
  }
}

function seriesName(collection) {
  return splitPascal(collection).join(' ');
}

async function catalog(extra = {}) {
  const items = Object.keys(SERIES).map((prefix) => ({
    id: `elisa:${prefix}`,
    type: 'series',
    name: seriesName(SERIES[prefix]),
  }));
  return Promise.all(items.map((m) => tmdb.enrich(m)));
}

async function meta(id) {
  const prefix = String(id).split(':')[1];
  const collection = SERIES[prefix];
  if (!collection) return null;
  const name = seriesName(collection);
  const videos = [];
  for (let n = 1; n <= 200; n++) {
    videos.push({
      id: `elisa:${prefix}:${n}`,
      title: `Ã‰pisode ${n}`,
      season: 1,
      episode: n,
    });
  }
  const base = {
    id,
    type: 'series',
    name,
    videos,
  };
  return tmdb.enrich(base);
}

async function stream(id, type) {
  // Format attendu : elisa:<prefix-site>:<numero-episode>
  // ex: elisa:hercai-1:12
  const parts = String(id).split(':');
  if (parts.length < 3) return [];
  const prefix = parts[1];
  const epNum = parseInt(parts[2], 10);
  if (!Number.isFinite(epNum)) return [];

  const collection = SERIES[prefix];
  if (!collection) {
    console.log(`Elisa : serie inconnue pour le prefix "${prefix}"`);
    return [];
  }

  const url = buildStreamUrl(prefix, collection, epNum);
  console.log(`Elisa ${prefix} ep ${epNum} -> ${url}`);
  const out = [
    {
      name: "Elisa's Addictions",
      title: `Elisa's Addictions VOSTFR (MP4)`,
      url,
      behaviorHints: { notWebReady: true },
    },
  ];
  const extra = EXTRA[`${prefix}:${epNum}`] || [];
  for (const u of extra) {
    out.push({
      name: "Elisa's Addictions",
      title: `Lien externe`,
      url: u,
      behaviorHints: { notWebReady: true },
    });
  }
  // Liens externes via Wix (si credentials configurés)
  const wixLinks = await wixFetch(prefix, epNum);
  for (const w of wixLinks) {
    // éviter les doublons avec le worker direct
    if (w.url && w.url !== url) out.push(w);
  }
  return out;
}

module.exports = {
  prefix: 'elisa:',
  types: ['series'],
  catalogId: 'elisa',
  catalogName: "Elisa's Addictions",
  catalog,
  meta,
  stream,
};


