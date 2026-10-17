
const crypto = require('crypto');
const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SECRET =
  process.env.PROXY_SECRET || crypto.randomBytes(16).toString('hex');

const PUBLIC = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ''
).replace(/\/+$/, '');

let active = 0;
const MAX_ACTIVE = 12;

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString();

const sign = (u, h) =>
  crypto
    .createHmac('sha256', SECRET)
    .update(u + '\n' + h)
    .digest('base64url');

function proxyUrl(target, headers) {
  if (!PUBLIC) return null;

  const ext =
    (
      target.match(
        /\.(m3u8|mp4|mkv|webm|ts|m4s|aac|key|vtt|srt)(?=$|\?)/i
      ) || []
    )[1] || 'bin';

  const u = b64(target);
  const h = b64(JSON.stringify(headers || {}));

  return `${PUBLIC}/proxy/${u}/${h}/${sign(u, h)}/v.${ext.toLowerCase()}`;
}

function playable({ name, title, url, headers }) {
  const p = proxyUrl(url, headers);

  if (p) {
    return { name, title, url: p };
  }

  return {
    name,
    title,
    url,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: headers || {} },
    },
  };
}

function rewritePlaylist(text, base, headers) {
  const wrap = (value) => {
    try {
      const absolute = new URL(value, base).href;
      return proxyUrl(absolute, headers) || absolute;
    } catch {
      return value;
    }
  };

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          return `URI="${wrap(uri)}"`;
        });
      }

      return wrap(trimmed);
    })
    .join('\n');
}

function toText(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', reject);
  });
}

async function handler(req, res) {
  const { u, h, sig } = req.params;

  if (!u || !h || !sig) {
    return res.status(400).end();
  }

  const expected = Buffer.from(sign(u, h));
  const received = Buffer.from(String(sig));

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return res.status(403).end();
  }

  let target;
  let headers;

  try {
    target = unb64(u);
    headers = JSON.parse(unb64(h));

    const parsed = new URL(target);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).end();
    }

    if (
      !headers ||
      typeof headers !== 'object' ||
      Array.isArray(headers)
    ) {
      return res.status(400).end();
    }
  } catch {
    return res.status(400).end();
  }

  if (active >= MAX_ACTIVE) {
    return res.set('Retry-After', '2').status(503).end();
  }

  active++;

  let released = false;
  let upstream = null;

  const controller = new AbortController();

  const release = () => {
    if (!released) {
      released = true;
      active--;
    }
  };

  // Libère le compteur et annule l'amont seulement si
  // le client a interrompu la réponse avant sa fin.
  res.on('close', () => {
    release();

    if (!res.writableEnded) {
      controller.abort();

      if (upstream) {
        upstream.destroy();
      }
    }
  });

  const out = {
    'User-Agent': UA,
    ...headers,
  };

  if (req.headers.range) {
    out.Range = req.headers.range;
  }

  try {
    const response = await axios.get(target, {
      headers: out,
      responseType: 'stream',
      timeout: 20000,
      maxRedirects: 5,
      signal: controller.signal,
      validateStatus: (status) => status < 400,
    });

    upstream = response.data;

    // Si le client est parti pendant la connexion amont.
    if (res.destroyed) {
      upstream.destroy();
      return;
    }

    const contentType = String(
      response.headers['content-type'] || ''
    );

    res.set('Access-Control-Allow-Origin', '*');

    const isPlaylist =
      /mpegurl/i.test(contentType) ||
      /\.m3u8(?:\?|$)/i.test(target);

    if (isPlaylist) {
      const text = await toText(upstream);

      if (res.destroyed) return;

      const finalUrl =
        response.request?.res?.responseUrl || target;

      res.set(
        'Content-Type',
        'application/vnd.apple.mpegurl'
      );

      return res.send(
        rewritePlaylist(text, finalUrl, headers)
      );
    }

    res.status(response.status);

    for (const key of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
    ]) {
      if (response.headers[key]) {
        res.set(key, response.headers[key]);
      }
    }

    upstream.on('error', (error) => {
      console.log('proxy ERREUR flux amont', {
        code: error.code || null,
        message: error.message,
      });

      if (!res.destroyed) {
        res.destroy(error);
      }
    });

    res.on('error', () => {
      upstream.destroy();
    });

    upstream.pipe(res);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) {
      return;
    }

    console.log('proxy ÉCHEC', {
      code: error.code || null,
      message: error.message,
      hostname: (() => {
        try {
          return new URL(target).hostname;
        } catch {
          return null;
        }
      })(),
      httpStatus: error.response?.status || null,
      server: error.response?.headers?.server || null,
      timeoutMs: error.config?.timeout || null,
    });

    if (!res.headersSent && !res.destroyed) {
      res.status(502).end();
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}

module.exports = {
  playable,
  handler,
  proxyUrl,
  rewritePlaylist,
};
