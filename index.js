// index.js : addon Stremio qui interroge les providers Nuvio via nuvio.js
// Prérequis : Node 18+, variable d'env TMDB_KEY, dossier providers/ et fichier nuvio.js à la racine
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { getStreams } = require('./nuvio');

// Noms des fichiers dans providers/ (sans .js). Retire ou ajoute ceux que tu as vraiment copiés.
const PROVIDERS = ['movix', 'coflix', 'frenchstream'];

const TIMEOUT_MS = 25000; // un provider trop lent est ignoré

const manifest = {
  id: 'community.karma.stremio',
  version: '1.1.0',
  name: 'Karma',
  description: 'Films et séries via providers Nuvio',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(() => {
        console.log(`[karma] ${label} : timeout après ${ms} ms`);
        resolve([]);
      }, ms)
    ),
  ]);
}

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[karma] requête ${type} ${id}`);

  const lists = await Promise.all(
    PROVIDERS.map((name) =>
      withTimeout(
        getStreams(name, type, id).catch((e) => {
          console.log(`[karma] ${name} ERREUR : ${e.message}`);
          return [];
        }),
        TIMEOUT_MS,
        name
      ).then((streams) => {
        console.log(`[karma] ${name} : ${streams.length} flux`);
        return streams.map((s) => ({ ...s, name: `Karma ${name}` }));
      })
    )
  );

  return { streams: lists.flat() };
});

const app = express();
app.use('/', getRouter(builder.getInterface()));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`[karma] addon prêt sur le port ${PORT}`));
