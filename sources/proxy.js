
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

// Certains fournisseurs (Movix/Purstream) déclarent leurs sous-titres
// directement en WebVTT dans le master HLS :
//   #EXT-X-MEDIA:TYPE=SUBTITLES,...,URI="subs_fr.vtt"
// Or la RFC 8216 exige que l'URI d'une piste SUBTITLES soit une playlist
// (m3u8 avec #EXTINF). Les lecteurs listent donc la piste mais échouent à
// la lire, d'où des sous-titres sélectionnables mais invisibles. On expose
// ces fichiers via une playlist de sous-titres d'un seul segment.
function subtitlePlaylistUrl(target, headers) {
  if (!PUBLIC) return null;

  const u = b64(target);
  const h = b64(JSON.stringify(headers || {}));

  return `${PUBLIC}/subs/${u}/${h}/${sign(u, h)}/v.m3u8`;
}

function subtitleSegmentUrl(target, headers) {
  if (!PUBLIC) return null;

  const u = b64(target);
  const h = b64(JSON.stringify(headers || {}));

  return `${PUBLIC}/subs/${u}/${h}/${sign(u, h)}/seg.vtt`;
}

const isRawSubtitle = (url) => /\.(vtt|srt)(?:[?#]|$)/i.test(url);

function vttDuration(text) {
  const time = (value) => {
    const parts = value.replace(',', '.').split(':').map(Number);

    return parts.reduce((total, part) => total * 60 + (part || 0), 0);
  };

  let max = 0;
  const re =
    /((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{1,3})/g;
  let match;

  while ((match = re.exec(text))) {
    const end = time(match[2]);

    if (end > max) max = end;
  }

  return max;
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

  const wrapSubtitle = (value) => {
    try {
      const absolute = new URL(value, base).href;

      if (!isRawSubtitle(absolute)) return wrap(absolute);

      return (
        subtitlePlaylistUrl(absolute, headers) ||
        proxyUrl(absolute, headers) ||
        absolute
      );
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
        // Seules les lignes #EXT-X-MEDIA TYPE=SUBTITLES peuvent pointer
        // directement vers un fichier .vtt/.srt.
        const subtitles =
          /^#EXT-X-MEDIA:/i.test(trimmed) &&
          /TYPE=SUBTITLES/i.test(trimmed);

        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          return `URI="${subtitles ? wrapSubtitle(uri) : wrap(uri)}"`;
        });
      }

      return wrap(trimmed);
    })
    .join('\n');
}

// Sert une playlist HLS de sous-titres (un seul segment WebVTT).
async function subtitleHandler(req, res) {
  const { u, h, sig } = req.params;

  if (!u || !h || !sig) return res.status(400).end();

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

  try {
    const response = await axios.get(target, {
      headers: { 'User-Agent': UA, ...headers },
      responseType: 'text',
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    });

    const text = String(response.data || '');
    const isPlaylist = /\.m3u8$/i.test(String(req.params.name || ''));

    // Le lecteur redemande le segment WebVTT via cette même route.
    if (!isPlaylist) {
      const hasTimestampMap = /^X-TIMESTAMP-MAP\s*[=:]/im.test(text);
      const vtt =
        /^WEBVTT/i.test(text.trimStart()) && !hasTimestampMap
          ? text.replace(
              /^(\uFEFF?\s*WEBVTT[^\n]*\n)/i,
              '$1X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n'
            )
          : text;

      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'text/vtt; charset=utf-8');

      return res.send(vtt);
    }

    const duration = Math.max(1, Math.ceil(vttDuration(text) || 3600));
    const segment =
      subtitleSegmentUrl(target, headers) ||
      proxyUrl(target, headers) ||
      target;

    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${duration}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXTINF:${duration.toFixed(3)},`,
      segment,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');

    return res.send(playlist);
  } catch (error) {
    if (res.destroyed) return;

    console.log('sous-titres ÉCHEC', {
      code: error.code || null,
      message: error.message,
      httpStatus: error.response?.status || null,
    });

    return res.status(502).end();
  }
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

  let _target;
  try { _target = Buffer.from(u, 'base64url').toString(); } catch { _target = u; }
  console.log('[PROXY] requête reçue :', _target);

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

    const ct = response.headers['content-type'] || (/\.(mp4|m4v)$/i.test(target) ? 'video/mp4'
      : /\.m3u8$/i.test(target) ? 'application/vnd.apple.mpegurl' : undefined);
    if (ct) res.set('Content-Type', ct);
    for (const key of ['content-length', 'content-range']) {
      if (response.headers[key]) res.set(key, response.headers[key]);
    }
    // Nuvio (et d'autres lecteurs) refusent parfois de démarrer sans Accept-Ranges.
    res.set('Accept-Ranges', response.headers['accept-ranges'] || 'bytes');
    res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.set('Content-Disposition', 'inline');

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
  subtitleHandler,
  proxyUrl,
  rewritePlaylist,
};
