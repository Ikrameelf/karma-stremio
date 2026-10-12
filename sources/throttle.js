// Limite les appels vers un même hébergeur et réessaie après un HTTP 429 (trop de requêtes).
// Sans dépendance : on lui passe la fonction qui fait la requête.
const queues = new Map(); // hôte -> promesse de la dernière requête en file
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pause demandée par le serveur (Retry-After, en secondes), bornée ; sinon pause croissante.
function waitFor(err, attempt, base, max) {
  const ra = Number(err && err.response && err.response.headers && err.response.headers['retry-after']);
  const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : base * attempt;
  return Math.min(ms, max);
}

async function withRetry(fn, { tries = 3, base = 1500, max = 5000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (err) {
      const is429 = err && err.response && err.response.status === 429;
      if (!is429 || attempt >= tries) throw err;
      await sleep(waitFor(err, attempt, base, max));
    }
  }
}

// Une seule requête à la fois par hôte, espacées d'au moins gapMs, avec réessai sur 429.
function limited(host, fn, { gapMs = 1200, ...retryOpts } = {}) {
  const prev = queues.get(host) || Promise.resolve();
  const run = prev.then(() => withRetry(fn, retryOpts));
  // La file continue même si cette requête échoue, après la pause entre deux appels.
  queues.set(host, run.catch(() => {}).then(() => sleep(gapMs)));
  return run;
}

module.exports = { limited, withRetry };
