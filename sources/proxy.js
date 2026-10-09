// Relais vidéo intégré : Stremio mobile ne sait pas toujours envoyer
// les en-têtes Referer/Origin exigés par certains serveurs vidéo.
//
// Le proxy télécharge donc lui-même le flux avec les bons en-têtes
// puis le renvoie au client Stremio.
//
// Pour les playlists HLS (.m3u8), les URLs des segments sont elles aussi
// transformées en URLs du proxy afin que les mêmes headers soient utilisés
// pour chaque requête vidéo.

const crypto = require('crypto');
const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SECRET =
  process.env.PROXY_SECRET ||
  crypto.randomBytes(16).toString('hex');

const PUBLIC = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ''
).replace(/\/+$/, '');

let active = 0;
const MAX_ACTIVE = 6;

// -----------------------------------------------------------------------------
// Encodage / signature
// -----------------------------------------------------------------------------

const b64 = (s) =>
  Buffer.from(s).toString('base64url');

const unb64 = (s) =>
  Buffer.from(s, 'base64url').toString();

const sign = (u, h) =>
  crypto
    .createHmac('sha256', SECRET)
    .update(u + '\n' + h)
    .digest('base64url');

// -----------------------------------------------------------------------------
// Création de l'URL du proxy
// -----------------------------------------------------------------------------

function proxyUrl(target, headers) {
  if (!PUBLIC) return null;

  const ext =
    (
      target.match(
        /\.(m3u8|mp4|mkv|webm|ts|m4s|aac|key)(?=$|\?)/i
      ) || []
    )[1] || 'bin';

  const u = b64(target);
  const h = b64(JSON.stringify(headers || {}));
  const sig = sign(u, h);

  return `${PUBLIC}/proxy/${u}/${h}/${sig}/v.${ext.toLowerCase()}`;
}

// -----------------------------------------------------------------------------
// Objet stream Stremio
// -----------------------------------------------------------------------------

function playable({ name, title, url, headers }) {
  const p = proxyUrl(url, headers);

  if (p) {
    return {
      name,
      title,
      url: p,
    };
  }

  return {
    name,
    title,
    url,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: headers,
      },
    },
  };
}

// -----------------------------------------------------------------------------
// Réécriture des playlists HLS
// -----------------------------------------------------------------------------

function rewritePlaylist(text, base, headers) {
  const wrap = (u) => {
    try {
      const abs = new URL(u, base).href;
      return proxyUrl(abs, headers) || abs;
    } catch {
      return u;
    }
  };

  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();

      if (!t) {
        return line;
      }

      // Ligne de commentaire HLS :
      // EXT-X-KEY:URI="..."
      // EXT-X-MAP:URI="..."
      // etc.
      if (t.startsWith('#')) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_, u) => `URI="${wrap(u)}"`
        );
      }

      // URL de segment / playlist enfant
      return wrap(t);
    })
    .join('\n');
}

// -----------------------------------------------------------------------------
// Conversion stream -> texte
// -----------------------------------------------------------------------------

const toText = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];

    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    stream.on('end', () => {
      resolve(
        Buffer.concat(chunks).toString('utf8')
      );
    });

    stream.on('error', reject);
  });

// -----------------------------------------------------------------------------
// Proxy
// -----------------------------------------------------------------------------

async function handler(req, res) {
  const { u, h, sig } = req.params;

  // Vérification de la signature
  try {
    const expected = Buffer.from(sign(u, h));
    const received = Buffer.from(String(sig));

    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return res.status(403).end();
    }
  } catch {
    return res.status(403).end();
  }

  // Décodage
  let target;
  let headers;

  try {
    target = unb64(u);
    headers = JSON.parse(unb64(h));

    if (!target || !/^https?:\/\//i.test(target)) {
      return res.status(400).end();
    }

    if (!headers || typeof headers !== 'object') {
      headers = {};
    }
  } catch {
    return res.status(400).end();
  }

  // Limitation du nombre de connexions
  if (active >= MAX_ACTIVE) {
    return res
      .set('Retry-After', '2')
      .status(503)
      .end();
  }

  active++;

  let released = false;

  const release = () => {
    if (!released) {
      released = true;
      active--;
    }
  };

  res.on('close', release);
  res.on('finish', release);

  // ---------------------------------------------------------------------------
  // Headers envoyés au serveur vidéo
  // ---------------------------------------------------------------------------

  const out = {
    'User-Agent': UA,
    ...headers,
  };

  // Le Range est indispensable pour certains segments / fichiers vidéo.
  if (req.headers.range) {
    out.Range = req.headers.range;
  }

  // On ne transmet pas au serveur amont certains headers du client
  // qui pourraient être incorrects.
  delete out.Host;
  delete out['Content-Length'];
  delete out['Accept-Encoding'];

  try {
    const up = await axios.get(target, {
      headers: out,
      responseType: 'stream',
      timeout: 20000,
      maxRedirects: 5,

      // On accepte les réponses 2xx et 3xx gérées par axios.
      validateStatus: (status) => status < 400,
    });

    const contentType = String(
      up.headers['content-type'] || ''
    ).toLowerCase();

    const finalUrl =
      (
        up.request &&
        up.request.res &&
        up.request.res.responseUrl
      ) || target;

    // Journal : ce que l'hébergeur répond vraiment (les segments .ts/.m4s ne sont pas listés, il y en a trop).
    if (!/\.(ts|m4s|aac)(\?|$)/i.test(target)) {
      console.log(
        `proxy OK HTTP ${up.status} ${contentType || '?'} ${up.headers['content-length'] || '?'} octets` +
        `${req.headers.range ? ' (Range ' + req.headers.range + ')' : ''} <- ${target.slice(0, 110)}`
      );
    }

    // Un hébergeur qui répond 200 avec une page HTML (lien expiré, protection anti-robot...) met le lecteur en
    // "playback error" sans explication : on le refuse et on affiche le début de la page dans les logs.
    if (/text\/html/i.test(contentType) && !/\.m3u8(\?|$)/i.test(finalUrl)) {
      const page = await toText(up.data);
      console.log(`proxy REFUSÉ : l'hébergeur renvoie une page web au lieu d'une vidéo : ${page.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (!res.headersSent) res.status(502).end();
      return;
    }

    // -------------------------------------------------------------------------
    // CORS
    // -------------------------------------------------------------------------

    res.set(
      'Access-Control-Allow-Origin',
      '*'
    );

    res.set(
      'Access-Control-Allow-Headers',
      '*'
    );

    // -------------------------------------------------------------------------
    // Playlist HLS
    // -------------------------------------------------------------------------

    if (
      /mpegurl/i.test(contentType) ||
      /\.m3u8(\?|$)/i.test(finalUrl)
    ) {
      const text = await toText(up.data);

      const rewritten = rewritePlaylist(
        text,
        finalUrl,
        headers
      );

      res.status(up.status);

      res.set(
        'Content-Type',
        'application/vnd.apple.mpegurl'
      );

      res.set(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );

      res.send(rewritten);

      return;
    }

    // -------------------------------------------------------------------------
    // Flux vidéo / segment HLS
    // -------------------------------------------------------------------------

    res.status(up.status);

    const forwardHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
    ];

    for (const key of forwardHeaders) {
      if (up.headers[key]) {
        res.set(key, up.headers[key]);
      }
    }

    // Important :
    // axios décompresse parfois automatiquement la réponse.
    // On ne transmet donc pas Content-Encoding au client.
    res.removeHeader('Content-Encoding');

    up.data.on('error', () => {
      if (!res.destroyed) {
        res.destroy();
      }
    });

    res.on('error', () => {
      if (up.data && !up.data.destroyed) {
        up.data.destroy();
      }
    });

    up.data.pipe(res);

    req.on('close', () => {
      if (up.data && !up.data.destroyed) {
        up.data.destroy();
      }
    });
  } catch (e) {
    console.log(
      'proxy ÉCHEC',
      e.response
        ? `HTTP ${e.response.status} (serveur : ${
            e.response.headers &&
            e.response.headers.server
              ? e.response.headers.server
              : '?'
          })`
        : e.code || e.message,
      target.slice(0, 160)
    );

    if (!res.headersSent) {
      res.status(502).end();
    }
  }
}

module.exports = {
  playable,
  handler,
  proxyUrl,
  rewritePlaylist,
};
