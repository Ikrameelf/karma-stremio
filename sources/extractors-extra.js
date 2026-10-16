
const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';

const T = 9000;
const T_FAST = 4500;

const lastSegment = (url) =>
  url.split('?')[0].split('/').filter(Boolean).pop();

const asJson = (data) =>
  typeof data === 'string' ? JSON.parse(data) : data;

// ───────────── Veev ─────────────

const jsInt = (x) => {
  const n = parseInt(x, 10);
  return Number.isNaN(n) ? 0 : n;
};

function veevDecode(enc) {
  try {
    const lut = {};
    let n = 256;
    let c = enc[0];
    const out = [c];

    for (let i = 1; i < enc.length; i++) {
      const ch = enc[i];
      const code = enc.charCodeAt(i);
      const nc =
        code < 256
          ? ch
          : lut[code] !== undefined
            ? lut[code]
            : c + c[0];

      out.push(nc);
      lut[n++] = c + nc[0];
      c = nc;
    }

    return out.join('');
  } catch {
    return enc;
  }
}

function veevBuildArray(enc) {
  const result = [];
  const chars = enc.split('');

  if (!chars.length) return result;

  let count = jsInt(chars.shift());

  while (count > 0) {
    const current = [];

    for (let i = 0; i < count; i++) {
      if (!chars.length) break;
      current.unshift(jsInt(chars.shift()));
    }

    result.push(current);

    if (!chars.length) break;
    count = jsInt(chars.shift());
  }

  return result;
}

function hexToStr(hex) {
  const h = String(hex).trim();
  return Buffer.from(h.length % 2 ? '0' + h : h, 'hex').toString('utf8');
}

function veevDecodeUrl(enc, tArray) {
  let decoded = enc;

  for (const t of tArray) {
    if (t === 1) {
      decoded = decoded.split('').reverse().join('');
    }

    decoded = hexToStr(decoded).split('dXRmOA==').join('');
  }

  return decoded;
}

async function veev(url) {
  const origin = new URL(url).origin;

  const response = await axios.get(url, {
    timeout: T,
    responseType: 'text',
    headers: {
      'User-Agent': UA,
      Referer: origin + '/',
    },
  });

  const html = String(response.data);
  const finalUrl =
    (response.request &&
      response.request.res &&
      response.request.res.responseUrl) ||
    url;

  const mediaId = lastSegment(finalUrl);

  const re =
    /[.\s'](?:fc|_vvto\[[^\]]*)(?:['\]]*)?\s*[:=]\s*['"]([^'"]+)/g;

  const encodedValues = [...html.matchAll(re)].map((m) => m[1]);
  let ch = null;

  for (const value of encodedValues.reverse()) {
    const decoded = veevDecode(value);

    if (decoded !== value) {
      ch = decoded;
      break;
    }
  }

  if (!ch) {
    console.log('  ↳ VEEV : paramètre "ch" introuvable');
    return [];
  }

  const arrays = veevBuildArray(ch);
  if (!arrays.length) return [];

  const api =
    `${origin}/dl?op=player_api&cmd=gi&file_code=` +
    `${encodeURIComponent(mediaId)}&ch=${encodeURIComponent(ch)}&ie=1`;

  const apiResponse = await axios.get(api, {
    timeout: T,
    headers: {
      'User-Agent': UA,
      Referer: url,
    },
  });

  const data = asJson(apiResponse.data);

  if (
    !data ||
    data.status !== 'success' ||
    !data.file ||
    data.file.file_status !== 'OK' ||
    !Array.isArray(data.file.dv)
  ) {
    console.log('  ↳ VEEV : réponse API inattendue');
    return [];
  }

  const results = [];

  for (const item of data.file.dv) {
    if (!item || !item.s) continue;

    const link = veevDecodeUrl(veevDecode(item.s), arrays[0]);

    if (/^https?:/i.test(link)) {
      results.push({
        url: link,
        kind: /\.m3u8/i.test(link) ? 'HLS' : 'MP4',
        headers: {
          Referer: origin + '/',
          'User-Agent': UA,
        },
      });
    }
  }

  console.log(`  ↳ VEEV ${origin} : ${results.length} lien(s) décodé(s)`);
  return results;
}

// ───────────── Vidzy ─────────────

async function vidzy(url, referer) {
  const match = String(url).match(
    /(?:\/d\/|\/download\/|\/file\/|\/f\/|\/v\/|\/embed-)([a-z0-9]+)/i
  );

  if (!match) return [];

  const host = 'vidzy.cc';
  const embedUrl = `https://${host}/embed-${match[1]}.html`;

  try {
    const response = await axios.get(embedUrl, {
      timeout: T_FAST,
      responseType: 'text',
      maxContentLength: 3000000,
      headers: {
        'User-Agent': UA,
        Referer: referer || `https://${host}/`,
      },
    });

    const html = String(response.data);

    // Le lecteur actuel utilise une variable E, et non l'ancien
    // motif de décodage recherché par la version précédente.
    const encoded = (
      html.match(/\bvar\s+E\s*=\s*["']([A-Za-z0-9+/=]+)["']/) || []
    )[1];

    if (!encoded) {
      const title =
        (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '?';

      console.log(
        `  ↳ VIDZY : variable E introuvable ` +
        `(${html.length} octets, titre « ${title.trim()} »)`
      );

      return [];
    }

    // Reproduction du décodage du lecteur Vidzy.
    const hostSum = [...Buffer.from(host, 'utf8')].reduce(
      (sum, char) => (sum + char) & 255,
      0
    );

    const reversed = Buffer.from(encoded, 'base64').reverse();
    const decoded = Buffer.alloc(reversed.length);

    // Le lecteur calcule BC à partir de la largeur d'un élément HTML.
    // La page diagnostiquée attend BC === 185.
    const BC = 185;

    for (let i = 0; i < reversed.length; i++) {
      const key = (0x3d + i * 89 + hostSum + BC) & 255;
      decoded[i] = reversed[i] ^ key;
    }

    const videoUrl = decoded.toString('utf8');

    if (!/^https?:\/\//i.test(videoUrl)) {
      console.log('  ↳ VIDZY : décodage invalide');
      return [];
    }

    if (!/\.m3u8(?:[?#]|$)/i.test(videoUrl)) {
      console.log('  ↳ VIDZY : URL décodée, mais pas de playlist HLS');
      return [];
    }

    console.log('  ↳ VIDZY : URL HLS extraite');

    return [
      {
        url: videoUrl,
        kind: 'HLS',
        headers: {
          Referer: embedUrl,
          Origin: `https://${host}`,
          'User-Agent': UA,
        },
      },
    ];
  } catch (error) {
    console.log(
      `  ↳ VIDZY : ÉCHEC ${
        error.response
          ? 'HTTP ' + error.response.status
          : error.code || error.message
      }`
    );

    return [];
  }
}

// ───────────── Vidaraa / Vidara ─────────────

async function vidaraa(url) {
  const origin = new URL(url).origin;

  const response = await axios.post(
    origin + '/api/stream',
    {
      filecode: lastSegment(url),
      device: 'web',
    },
    {
      timeout: T,
      headers: {
        Referer: url,
        Origin: origin,
        'User-Agent': UA,
      },
    }
  );

  const data = asJson(response.data);
  const streamUrl = data && data.streaming_url;

  if (!streamUrl) {
    console.log(
      `  ↳ VIDARA : pas de streaming_url (${JSON.stringify(data).slice(0, 200)})`
    );
    return [];
  }

  console.log(`  ↳ VIDARA ${origin} : 1 lien décodé`);

  return [
    {
      url: streamUrl,
      kind: /\.m3u8/i.test(streamUrl) ? 'HLS' : 'MP4',
      headers: {
        Referer: origin + '/',
        'User-Agent': UA,
      },
    },
  ];
}

// ───────────── GoodStream ─────────────

async function goodstream(url) {
  const origin = new URL(url).origin;

  const body = new URLSearchParams({
    op: 'embed',
    file_code: lastSegment(url),
    auto: '1',
    referer: '',
  }).toString();

  const response = await axios.post(origin + '/dl', body, {
    timeout: T,
    responseType: 'text',
    headers: {
      Referer: url,
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const streamUrl =
    (String(response.data).match(/file\s*:\s*"(.*?)"/) || [])[1];

  if (!streamUrl) return [];

  return [
    {
      url: streamUrl,
      kind: 'HLS',
      headers: {
        Referer: origin + '/',
        Origin: origin,
        'User-Agent': UA,
      },
    },
  ];
}

// ───────────── FireStream ─────────────

async function firestream(url, referer) {
  const response = await axios.get(url, {
    timeout: T_FAST,
    responseType: 'text',
    maxContentLength: 3000000,
    headers: {
      'User-Agent': UA,
      Referer: referer || new URL(url).origin + '/',
    },
  });

  const html = String(response.data);

  const match = html.match(
    /<script[^>]+id=["']video-data["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (!match) {
    console.log('  ↳ FIRESTREAM : bloc video-data introuvable');
    return null;
  }

  console.log(
    `  ↳ FIRESTREAM video-data : ${match[1].replace(/\s+/g, ' ').slice(0, 1200)}`
  );

  // L'extraction FireStream reste à implémenter.
  return null;
}

// ───────────── Uqload ─────────────

async function uqload(url, referer) {
  const { unpackAll } = require('./extractors');
  const origin = new URL(url).origin;

  const firefoxUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0';

  const response = await axios.get(url, {
    timeout: T_FAST,
    responseType: 'text',
    maxContentLength: 3000000,
    headers: {
      'User-Agent': firefoxUA,
      Referer: referer || origin + '/',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  const html = String(response.data);
  const combinedText = unpackAll(html) + '\n' + html;

  const cookie = (response.headers['set-cookie'] || [])
    .map((item) => item.split(';')[0])
    .join('; ');

  const normalized = combinedText.replace(/\\\//g, '/');

  const m3u8 =
    (
      normalized.match(
        /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/
      ) || []
    )[0];

  const mp4 =
    (
      normalized.match(
        /https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/
      ) || []
    )[0];

  const streamUrl = m3u8 || mp4;
  if (!streamUrl) return [];

  const headers = {
    'User-Agent': firefoxUA,
    Accept: '*/*',
    Origin: origin,
    Referer: origin + '/',
  };

  if (cookie) headers.Cookie = cookie;

  return [
    {
      url: streamUrl,
      kind: m3u8 ? 'HLS' : 'MP4',
      headers,
    },
  ];
}

// ───────────── Routage des extracteurs ─────────────

async function resolveExtra(url, referer) {
  let host;

  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }

  try {
    if (/(^|\.)veev\./i.test(host)) {
      return await veev(url);
    }

    if (/(^|\.)vidzy\.(cc|org)$/i.test(host)) {
      return await vidzy(url, referer);
    }

    if (/(^|\.)vidaraa?\./i.test(host)) {
      return await vidaraa(url);
    }

    if (/(^|\.)goodstream\./i.test(host)) {
      return await goodstream(url);
    }

    if (/(^|\.)uqload\./i.test(host)) {
      return await uqload(url, referer);
    }

    if (/(^|\.)firestream\./i.test(host)) {
      return await firestream(url, referer);
    }
  } catch (error) {
    const timedOut = /ECONNABORTED|ETIMEDOUT/.test(error.code || '');

    console.log(
      `  ↳ extra ${host} : ÉCHEC ${
        error.response
          ? 'HTTP ' + error.response.status
          : error.code || error.message
      }`
    );

    if (timedOut) {
      const empty = [];
      empty.timedOut = true;
      return empty;
    }

    return [];
  }

  return null;
}

// Important : ce fichier exporte resolveExtra.
module.exports = { resolveExtra };
