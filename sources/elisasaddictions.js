// sources/elisasaddictions.js
// Flux directs Elisa's Addictions (worker MP4) pour l'addon karma.
// Les URLs directes sont publiques mais leur chemin (dossier/abreviation) varie par serie.
// On les derive du nom de collection Wix (PascalCase) : dossier = nom avec espaces,
// abreviation = initiales (ou nom complet si un seul mot).

const SERIES = {
  'banasevmeyianlat': 'BanaSevmeyiAnlat',
  'carpisma-1': 'Carpisma',
  'reaksiyon-1': 'Reaksiyon',
  'calikusu': 'Calikusu',
  'askintarifi': 'AskinTarifi',
  'bayyanlis': 'BayYanlis',
  'ada-masali': 'AdaMasali',
  'guvercin-1': 'Guvercin',
  'dolunay-1': 'Dolunay',
  'muhtesem-ikili': 'MuhtesemIkili',
  'erkenci-kus': 'ErkenciKus',
  'seref-meselesi': 'SerefMeselesi',
  'uyanis-buyuk-selcuklu': 'UyanisBuyukSelcuklu',
  'inadinaask': 'InadinaAsk',
  'yabani-1': 'Yabani',
  'siyah-inci': 'SiyahInci',
  'tatli-intikam': 'TatliIntikam',
  'birkucukgunisigi': 'BirKucukGunIsigi',
  'kurulusosman': 'KurulusOsman',
  'hercai-1': 'Hercai',
  'alev-alev': 'AlevAlev',
  'yalicapkini': 'YaliCapkini',
  'adizehra': 'AdiZehra',
  'meryem-1': 'Meryem',
  'hudutsuz-sevda': 'HudutsuzSevda',
  'bahtoyunu': 'AskinTarifi1',
  'her-yerde-sen': 'HerYerdeSen',
  'asklaftananlamaz': 'AskLaftanAnlamaz',
  'sol-yanim': 'SolYanim',
  'atesbocegi': 'Atesbocegi',
  'akinci': 'Akinci',
  'sen-cal-kapimi': 'SenCalKapimi',
  'senden-daha-guzel': 'SendenDahaGuzel',
  'babamingunahlari': 'BabaminGunahlari1',
  'adimfarah': 'AdimFarah',
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

function buildStreamUrl(collection, epNum) {
  const { folder, abbr } = folderAndAbbr(collection);
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
      title: `Épisode ${n}`,
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

  const url = buildStreamUrl(collection, epNum);
  console.log(`Elisa ${prefix} ep ${epNum} -> ${url}`);
  return [
    {
      name: "Elisa's Addictions",
      title: `Elisa's Addictions VOSTFR (MP4)`,
      url,
      behaviorHints: { notWebReady: true },
    },
  ];
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
