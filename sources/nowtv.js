const axios = require('axios');
const { playable } = require('./proxy');

const BASE = 'https://www.nowtv.com.tr';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
  },
});

const enc = (s) => Buffer.from(s).toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString();

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanTitle(s) {
  return slugify(s).replace(/-/g, '');
}

async function getCinemetaTitle(imdbId) {
  try {
    const { data } = await http.get(
      `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`
    );

    return (
      data &&
      data.meta &&
      (data.meta.name || data.meta.originalName)
    ) || '';
  } catch (e) {
    console.log('NOW TV Cinemeta:', e.message);
    return '';
  }
}

async function getNowSlugs(title) {
  const candidates = [];

  const add = (value) => {
    const slug = slugify(value);
    if (slug && !candidates.includes(slug)) {
      candidates.push(slug);
    }
  };

  add(title);

  // Quelques variantes fréquentes
  add(String(title).replace(/^The-/i, ''));
  add(String(title).replace(/^Bir-/i, ''));
  add(String(title).replace(/^the\s+/i, ''));
  add(String(title).replace(/^bir\s+/i, ''));

  return candidates;
}

async function getVideoUrl(showSlug, episode) {
  try {
    const episodeUrl =
      `${BASE}/${showSlug}/bolum/${episode}`;

    const page = await http.get(episodeUrl, {
      headers: {
        Referer: `${BASE}/`,
      },
    });

    const html = page.data;

    const match =
      html.match(/video_id["']?\s*[:=]\s*["']?(\d+)/i);

    if (!match) {
      return null;
    }

    const videoId = match[1];

    const response = await http.post(
      `${BASE}/ajax/stream`,
      `video_id=${encodeURIComponent(videoId)}`,
      {
        headers: {
          'User-Agent': UA,
          'Content-Type':
            'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE,
          Referer: episodeUrl,
        },
      }
    );

    const data = response.data;

    if (
      !data ||
      data.code !== 200 ||
      !data.video_url
    ) {
      return null;
    }

    return {
      url: data.video_url,
      episodeUrl,
    };
  } catch (e) {
    return null;
  }
}

async function stream(id) {
  try {
    // Exemple : tt1234567:1:5
    const parts = String(id).split(':');

    const imdbId = parts[0];

    let season = 1;
    let episode = 1;

    if (parts.length >= 3) {
      season = parseInt(parts[parts.length - 2], 10) || 1;
      episode = parseInt(parts[parts.length - 1], 10) || 1;
    } else if (parts.length === 2) {
      episode = parseInt(parts[1], 10) || 1;
    }

    if (!/^tt\d+$/i.test(imdbId)) {
      return [];
    }

    const title = await getCinemetaTitle(imdbId);

    if (!title) {
      console.log('NOW TV : titre Cinemeta introuvable pour', imdbId);
      return [];
    }

    const slugs = await getNowSlugs(title);

    for (const slug of slugs) {
      const result = await getVideoUrl(slug, episode);

      if (!result) continue;

      console.log(
        `NOW TV trouvé : ${title} → ${slug} → épisode ${episode}`
      );

      return [
        playable({
          name: 'NOW TV Türkiye',
          title: `NOW TV Türkiye · ${title} · Bölüm ${episode}`,
          url: result.url,
          headers: {
            'User-Agent': UA,
            Referer: result.episodeUrl,
          },
        }),
      ];
    }

    console.log(
      `NOW TV : aucun épisode trouvé pour ${title} (${season}x${episode})`
    );

    return [];
  } catch (e) {
    console.error('NOW TV:', e.message);
    return [];
  }
}

module.exports = {
  prefix: 'tt',
  types: ['series'],
  stream,
};
