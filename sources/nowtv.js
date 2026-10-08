const axios = require('axios');
const { playable } = require('./proxy');
const BASE = 'https://www.nowtv.com.tr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const http = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    'User-Agent': UA,
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
  },
});
function slugify(value) {
  return String(value || '')
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
async function getCinemetaMeta(imdbId) {
  try {
    const { data } = await http.get(
      `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`
    );
    const meta = data && data.meta;
    if (!meta) {
      console.log(
        `[now] Cinemeta: aucune meta pour ${imdbId}`
      );
      return null;
    }
    console.log(
      `[now] Cinemeta: ${meta.name || meta.originalName || imdbId}`
    );
    return meta;
  } catch (e) {
    console.log(
      `[now] Cinemeta ERREUR ${imdbId}: ${e.message}`
    );
    return null;
  }
}
function getCandidateSlugs(meta) {
  const candidates = [];
  const add = (value) => {
    const slug = slugify(value);
    if (
      slug &&
      !candidates.includes(slug)
    ) {
      candidates.push(slug);
    }
  };
  add(meta && meta.name);
  add(meta && meta.originalName);
  if (meta && Array.isArray(meta.aliases)) {
    for (const alias of meta.aliases) {
      add(alias);
    }
  }
  return candidates;
}
async function getEpisodePage(showSlug, episode) {
  const urls = [
    `${BASE}/${showSlug}/bolum/${episode}`,
    `${BASE}/${showSlug}/bolum/${episode}/`,
  ];
  for (const url of urls) {
    try {
      console.log(
        `[now] page: ${url}`
      );
      const response = await http.get(url, {
        headers: {
          Referer: `${BASE}/`,
        },
      });
      const html = String(response.data || '');
      console.log(
        `[now] page OK: ${response.status}, ${html.length} octets`
      );
      return {
        url: response.request &&
          response.request.res &&
          response.request.res.responseUrl
          ? response.request.res.responseUrl
          : url,
        html,
      };
    } catch (e) {
      console.log(
        `[now] page ECHEC ${url}: ${e.response ? e.response.status : e.message}`
      );
    }
  }
  return null;
}
function extractVideoId(html) {
  const patterns = [
    /["']video_id["']\s*[:=]\s*["']?(\d+)/i,
    /["']videoId["']\s*[:=]\s*["']?(\d+)/i,
    /data-video-id\s*=\s*["'](\d+)["']/i,
    /data-video_id\s*=\s*["'](\d+)["']/i,
    /video_id\s*=\s*["']?(\d+)/i,
    /videoId\s*=\s*["']?(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}
function extractDirectVideoUrl(html) {
  const patterns = [
    /["']video_url["']\s*:\s*["']([^"']+)["']/i,
    /["']videoUrl["']\s*:\s*["']([^"']+)["']/i,
    /["']src["']\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)(?:[^"']*)?)["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1]
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
    }
  }
  return null;
}
async function requestStream(videoId, episodeUrl) {
  try {
    console.log(
      `[now] ajax/stream video_id=${videoId}`
    );
    const response = await http.post(
      `${BASE}/ajax/stream`,
      `video_id=${encodeURIComponent(videoId)}`,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Content-Type':
            'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE,
          Referer: episodeUrl,
        },
      }
    );
    const data = response.data;
    console.log(
      `[now] ajax/stream HTTP ${response.status}`
    );
    if (data && typeof data === 'object') {
      console.log(
        `[now] ajax/stream code=${data.code || '?'} video_url=${data.video_url ? 'OUI' : 'NON'}`
      );
    } else {
      console.log(
        `[now] ajax/stream réponse non JSON`
      );
    }
    if (
      data &&
      data.code === 200 &&
      data.video_url
    ) {
      return data.video_url;
    }
    return null;
  } catch (e) {
    console.log(
      `[now] ajax/stream ERREUR: ${
        e.response
          ? `HTTP ${e.response.status}`
          : e.message
      }`
    );
    if (e.response && e.response.data) {
      console.log(
        '[now] ajax/stream réponse:',
        typeof e.response.data === 'string'
          ? e.response.data.slice(0, 500)
          : JSON.stringify(e.response.data).slice(0, 500)
      );
    }
    return null;
  }
}
async function getVideoUrl(showSlug, episode) {
  const page = await getEpisodePage(
    showSlug,
    episode
  );
  if (!page) {
    return null;
  }
  /*
   * 1. On cherche d'abord un video_id.
   */
  const videoId = extractVideoId(
    page.html
  );
  if (videoId) {
    console.log(
      `[now] video_id trouvé: ${videoId}`
    );
    const videoUrl =
      await requestStream(
        videoId,
        page.url
      );
    if (videoUrl) {
      return {
        url: videoUrl,
        episodeUrl: page.url,
      };
    }
  } else {
    console.log(
      `[now] aucun video_id trouvé dans ${page.url}`
    );
  }
  /*
   * 2. Si NOW met directement une URL vidéo
   * dans le HTML, on tente aussi cette méthode.
   */
  const directUrl =
    extractDirectVideoUrl(page.html);
  if (directUrl) {
    console.log(
      `[now] URL vidéo directe trouvée`
    );
    return {
      url: directUrl,
      episodeUrl: page.url,
    };
  }
  /*
   * 3. Affichage de quelques indices du HTML
   * pour pouvoir diagnostiquer sans afficher toute la page.
   */
  const interesting =
    page.html.match(
      /.{0,100}(video_id|videoId|video_url|videoUrl|m3u8|mp4).{0,200}/gi
    );
  if (interesting && interesting.length) {
    console.log(
      '[now] indices vidéo trouvés dans HTML:'
    );
    for (const line of interesting.slice(0, 5)) {
      console.log(
        line.replace(/\s+/g, ' ').slice(0, 500)
      );
    }
  }
  return null;
}
async function stream(id) {
  try {
    console.log(
      `[now] STREAM reçu: ${id}`
    );
    const parts =
      String(id).split(':');
    const imdbId = parts[0];
    let season = 1;
    let episode = 1;
    if (parts.length >= 3) {
      season =
        parseInt(
          parts[parts.length - 2],
          10
        ) || 1;
      episode =
        parseInt(
          parts[parts.length - 1],
          10
        ) || 1;
    } else if (parts.length === 2) {
      episode =
        parseInt(
          parts[1],
          10
        ) || 1;
    }
    console.log(
      `[now] IMDb=${imdbId} saison=${season} épisode=${episode}`
    );
    if (!/^tt\d+$/i.test(imdbId)) {
      console.log(
        `[now] ID IMDb invalide: ${imdbId}`
      );
      return [];
    }
    const meta =
      await getCinemetaMeta(imdbId);
    if (!meta) {
      return [];
    }
    const title =
      meta.name ||
      meta.originalName ||
      imdbId;
    const slugs =
      getCandidateSlugs(meta);
    console.log(
      `[now] titre="${title}" slugs=${JSON.stringify(slugs)}`
    );
    for (const slug of slugs) {
      const result =
        await getVideoUrl(
          slug,
          episode
        );
      if (!result) {
        console.log(
          `[now] aucun flux pour ${slug}/bolum/${episode}`
        );
        continue;
      }
      console.log(
        `[now] FLUX TROUVÉ: ${title} → ${slug} → épisode ${episode}`
      );
      return [
        playable({
          name: 'NOW TV Türkiye',
          title:
            `NOW TV Türkiye · ${title} · Bölüm ${episode}`,
          url: result.url,
          headers: {
            'User-Agent': UA,
            Referer: result.episodeUrl,
            Origin: BASE,
          },
        }),
      ];
    }
    console.log(
      `[now] AUCUN FLUX: ${title} (${season}x${episode})`
    );
    return [];
  } catch (e) {
    console.error(
      '[now] ERREUR GÉNÉRALE:',
      e.stack || e.message
    );
    return [];
  }
}
module.exports = {
  prefix: 'tt',
  types: ['series'],
  stream,
};
