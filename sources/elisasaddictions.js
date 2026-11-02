// sources/elisasaddictions.js
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
  'kurulusosman': 'KurulusOsman',
  'yabani-1': 'Yabani',
  'atesbocegi': 'Atesbocegi',
  'hudutsuz-sevda': 'HudutsuzSevda',
  'guvercin-1': 'Guvercin',
  'siyah-inci': 'SiyahInci',
  'asklaftananlamaz': 'AskLaftanAnlamaz',
  'sen-cal-kapimi': 'SenCalKapimi',
  'hercai-1': 'Hercai',
  'her-yerde-sen': 'HerYerdeSen',
  'uyanis-buyuk-selcuklu': 'UyanisBuyukSelcuklu',
  'ada-masali': 'AdaMasali',
  'banasevmeyianlat': 'BanaSevmeyiAnlat',
  'alev-alev': 'AlevAlev',
  'meryem-1': 'Meryem',
  'muhtesem-ikili': 'MuhtesemIkili',
  'dolunay-1': 'Dolunay',
  'akinci': 'Akinci',
  'adimfarah': 'AdimFarah',
  'seref-meselesi': 'SerefMeselesi',
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
  const abbr = FILES[prefix];
  const words = splitPascal(collection);
  const folder = words.join(' ');
  const n = String(epNum).padStart(2, '0');
  const folderEnc = encodeURIComponent(folder).replace(/%20/g, '+');
  return `https://streaming.elisasaddictions.workers.dev/file/ElisasAddictions/${folderEnc}/${abbr}_VOSTFR_${n}.mp4`;
}

function seriesName(collection) {
  return splitPascal(collection).join(' ');
}

async function catalog(extra = {}) {
  return Object.keys(SERIES).map((prefix) => ({
    id: `elisa:${prefix}`,
    type: 'series',
    name: seriesName(SERIES[prefix]),
  }));
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
  return {
    id,
    type: 'series',
    name,
    videos,
  };
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

