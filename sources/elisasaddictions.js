// Source de test Elisa's Addictions : Hercai VOSTFR épisode 01.
// Le lien MP4 est fourni par l'utilisateur ; aucune extraction ni URL d'épisode n'est supposée.
const EPISODE_1 =
  'https://streaming.elisasaddictions.workers.dev/file/ElisasAddictions/Hercai/Hercai_VOSTFR_01.mp4';

const SERIES_ID = 'elisa:hercai';

async function catalog({ search } = {}) {
  if (search && !/hercai/i.test(search)) return [];
  return [{ id: SERIES_ID, type: 'series', name: 'Hercai' }];
}

async function meta(id) {
  if (id !== SERIES_ID) return null;
  return {
    id: SERIES_ID,
    type: 'series',
    name: 'Hercai',
    videos: [{
      id: 'elisa:hercai:1',
      title: 'Épisode 01 · VOSTFR',
      season: 1,
      episode: 1,
    }],
  };
}

async function stream(id, type) {
  if (type !== 'series' || id !== 'elisa:hercai:1') return [];
  return [{
    name: 'Elisa\'s Addictions',
    title: 'Hercai · Épisode 01 · VOSTFR · MP4',
    url: EPISODE_1,
    behaviorHints: { notWebReady: true },
  }];
}

module.exports = {
  prefix: 'elisa:',
  catalogId: 'elisa-test',
  catalogName: 'Elisa\'s Addictions (test)',
  types: ['series'],
  genres: [],
  catalog,
  meta,
  stream,
};
