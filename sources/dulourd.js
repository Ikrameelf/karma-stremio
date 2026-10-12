// Provider Dulourd pour Karma-Stremio.
// Basé sur les motifs observés dans le plugin Cloudstream DuLourdProvider.
// Le domaine est configurable via DULOURD_DOMAIN (sans https://).
const axios = require('axios');
const cheerio = require('cheerio');
const { resolveEmbed } = require('./extractors');
const { playable } = require('./proxy');

const DOMAIN = (process.env.DULOURD_DOMAIN || 'www.dulourd.hair').replace(/^https?:\/\//, '').replace(/\/$/, '');
const BASE = `https://${DOMAIN}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const http = axios.create({
  timeout: 18000,
  maxRedirects: 8,
  headers: { 'User-Agent': UA, Referer: BASE + '/', Origin: BASE },
  validateStatus: (s) => s >= 200 && s < 500,
});
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const abs = (u, base = BASE + '/') => { try { return u ? new URL(u, base).href : null; } catch { return null; } };
const pathOf = (u) => { const x = new URL(u, BASE); return x.pathname + x.search; };
const isSite = (u) => { try { return new URL(u).hostname.endsWith(DOMAIN.replace(/^www\./, '')); } catch { return false; } };
const isAsset = (u) => /\.(?:jpe?g|png|webp|gif|svg|ico|css|js|woff2?|ttf|vtt|srt)(?:[?#]|$)/i.test(u);
const isDirect = (u) => /\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(u);
const isAd = /doubleclick|googlesyndication|popads|adsterra|exoclick|trafficjunky|sharethis/i;
const GENRES = {
  Action: '/voir-series/action_s/', Animation: '/voir-series/animation_s/', Aventure: '/voir-series/aventure_s/',
  Biopic: '/voir-series/biopic-s/', Comédie: '/voir-series/comedie_s/', Documentaire: '/voir-series/documentaire-s/',
  Drame: '/voir-series/drame_s/', Famille: '/voir-series/famille-s/', Fantastique: '/voir-series/fantastique_s/',
  Guerre: '/voir-series/guerre_s/', Historique: '/voir-series/historique_s/', Horreur: '/voir-series/horreur_s/',
  Judiciaire: '/voir-series/judiciare_s/', Musical: '/voir-series/musical_s/', Policier: '/voir-series/policier_s/',
  Romance: '/voir-series/romance_s/', Thriller: '/voir-series/thriller_s/', Western: '/voir-series/western_s/',
};
const html = async (url, headers = {}) => String((await http.get(url, { headers, responseType: 'text' })).data || '');

function parseCards($) {
  const out = new Map();

  // Dulourd a plusieurs gabarits de cartes : ne pas dépendre uniquement de
  // #dle-content > article / .movie-box / .item, qui peuvent ne pas exister.
  // On prend les liens de fiches série (ID numérique + slug), en excluant
  // les liens de navigation comme /voir-series/drame_s/.
  $('a[href*="/voir-series/"]').each((_, el) => {
    const a = $(el);
    const href = abs(a.attr('href'));
    if (!href || !isSite(href)) return;

    let pathname;
    try { pathname = new URL(href).pathname; } catch { return; }
    if (!/^\/voir-series\/[^/]+\/\d+-[^/]+\.html$/i.test(pathname)) return;

    const title = (a.attr('title') || a.attr('data-title') || a.text() || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2) return;

    // Cherche l'image dans le lien ou dans ses conteneurs proches : le HTML
    // de Dulourd n'utilise pas toujours la même structure de carte.
    let img = a.find('img').first();
    if (!img.length) img = a.closest('article, .item, .short, .movie-box, .movie-item, li, div').find('img').first();
    const poster = abs(
      img.attr('data-src') || img.attr('data-original') || img.attr('data-lazy-src') || img.attr('src'),
      href
    );

    const id = 'dulourd:' + b64(pathOf(href));
    if (!out.has(id)) {
      out.set(id, {
        id,
        type: 'series',
        name: title,
        ...(poster ? { poster } : {}),
        posterShape: 'poster',
      });
    }
  });

  return [...out.values()];
}
async function catalog({ genre, search, skip = 0 } = {}) {
  const page = Math.max(1, Math.floor(Number(skip || 0) / 20) + 1);
  let url;
  if (search) {
    url = `${BASE}/index.php?do=search&subaction=search&story=${encodeURIComponent(search)}`;
    if (page > 1) url += `&search_start=${page}`;
  } else {
    const path = GENRES[genre] || '/voir-series/';
    url = `${BASE}${path}${page > 1 ? `page/${page}/` : ''}`;
  }
  const $ = cheerio.load(await html(url));
  return parseCards($);
}

function parseEpisodeNumber(text, fallback) {
  const m = String(text || '').match(/(?:episode|épisode|ep)\s*(\d+)/i) || String(text || '').match(/(\d+)\s*[-.]?\s*episode/i);
  return m ? Number(m[1]) : fallback;
}

async function meta(id) {
  let path;
  try { path = unb64(id.slice('dulourd:'.length)); } catch { return null; }
  const pageUrl = abs(path);
  const $ = cheerio.load(await html(pageUrl));
  const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
  if (!title) return null;
  const poster = abs($('meta[property="og:image"]').attr('content') || $('div.img img').first().attr('src'), pageUrl);
  const description = $('div.description').text().trim() || $('meta[name="description"]').attr('content') || '';
  const year = ($('li.release > span').text().match(/\b(19|20)\d{2}\b/) || $('body').text().match(/\b(19|20)\d{2}\b/) || [])[0];
  const genres = $('div.category > a, li.category a').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const episodeMap = new Map();
  $('a[href*="-saison/"][href*="-episode.html"], a[href*="/episode/"]').each((i, el) => {
    const a = $(el); const href = abs(a.attr('href'), pageUrl); if (!href || !isSite(href)) return;
    const text = a.text().trim() || a.attr('title') || `Épisode ${i + 1}`;
    const seasonMatch = href.match(/(\d+)-saison/i) || text.match(/saison\s*(\d+)/i);
    const season = seasonMatch ? Number(seasonMatch[1]) : 1;
    const episode = parseEpisodeNumber(text, Number((href.match(/(\d+)-episode/i) || [])[1]) || i + 1);
    const key = `${season}:${episode}`;
    if (!episodeMap.has(key)) episodeMap.set(key, {
      id: `dulourd:ep:${b64(pathOf(href))}:${b64(path)}`,
      title: text.replace(/\s+/g, ' '), season, episode,
      released: new Date(Date.UTC(2000, 0, Math.min(28, episode))).toISOString(),
    });
  });
  // Si la fiche de série n'énumère pas ses épisodes, la page courante peut elle-même être une page d'épisode.
  if (!episodeMap.size && /-saison\/\d+-episode\.html/i.test(path)) {
    const sm = path.match(/(\d+)-saison/i); const em = path.match(/(\d+)-episode/i);
    const season = sm ? Number(sm[1]) : 1; const episode = em ? Number(em[1]) : 1;
    episodeMap.set(`${season}:${episode}`, { id: `dulourd:ep:${b64(path)}:${b64(path)}`, title: `Saison ${season} épisode ${episode}`, season, episode });
  }
  const videos = [...episodeMap.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { id, type: 'series', name: title.replace(/\s*[-|].*$/, '').trim(), poster: poster || undefined, background: poster || undefined, description, releaseInfo: year, genres: [...new Set(genres)], videos };
}

function candidateUrls(pageHtml, pageUrl) {
  const $ = cheerio.load(pageHtml); const found = new Set();
  const add = (u) => { const x = abs(u, pageUrl); if (x && /^https?:/i.test(x) && !isAsset(x) && !isAd.test(x)) found.add(x.split('#')[0]); };
  $('iframe, source, video').each((_, el) => { const e = $(el); add(e.attr('src') || e.attr('data-src') || e.attr('data-lazy-src')); });
  $('a[href], [onclick]').each((_, el) => {
    const e = $(el); add(e.attr('href'));
    const raw = e.attr('onclick') || '';
    for (const m of raw.matchAll(/https?:\\?\/\\?\/[^'"\s)]+/g)) add(m[0].replace(/\\\//g, '/'));
  });
  // Quelques lecteurs stockent les URL dans des scripts ou des chaînes échappées.
  const normalized = pageHtml.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  for (const m of normalized.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) add(m[0].replace(/[),;]+$/, ''));
  const redirect = normalized.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
  if (redirect) add(redirect[1]);
  return [...found];
}

async function stream(id) {
  const parts = id.split(':');
  if (parts[1] !== 'ep' || !parts[2]) return [];
  let epPath, seriesPath;
  try { epPath = unb64(parts[2]); seriesPath = parts[3] ? unb64(parts[3]) : epPath; } catch { return []; }
  const epUrl = abs(epPath); const referer = abs(seriesPath) || BASE + '/';
  const headers = { 'User-Agent': UA, Referer: referer, Origin: BASE };
  const streams = []; const seen = new Set(); const pages = new Set([epUrl]);
  try {
    const episodeHtml = await html(epUrl, headers);
    candidateUrls(episodeHtml, epUrl).filter(isSite).forEach((u) => {
      if (/regarder-serie|action=playEpisode|Season\.php/i.test(u)) pages.add(u);
    });
    // Le bouton « Regarder » renvoie souvent à une page intermédiaire. On suit ses redirections et inspecte son HTML.
    const $ = cheerio.load(episodeHtml);
    $('a[href]').each((_, el) => {
      const text = $(el).text().trim().toLowerCase(); const href = abs($(el).attr('href'), epUrl);
      if (href && (/regarder|watch|play/i.test(text) || /regarder-serie2\.php/i.test(href))) pages.add(href);
    });
    for (const page of [...pages].slice(0, 5)) {
      let body = '';
      try { body = await html(page, { ...headers, Referer: epUrl }); } catch (e) { console.log('Dulourd page:', e.code || e.message); continue; }
      const urls = candidateUrls(body, page);
      for (const url of urls) {
        if (seen.has(url) || isAd.test(url)) continue;
        seen.add(url);
        if (isDirect(url)) {
          streams.push(playable({ name: 'Dulourd', title: /\.m3u8/i.test(url) ? 'Direct HLS' : 'Direct vidéo', url, headers: { ...headers, Referer: page } }));
        } else if (!isSite(url)) {
          try {
            const links = await resolveEmbed(url, page);
            for (const link of links || []) {
              if (!link.url || seen.has(link.url)) continue;
              seen.add(link.url);
              streams.push(playable({ name: 'Dulourd', title: `${new URL(url).hostname} · ${link.kind || 'vidéo'}`, url: link.url, headers: link.headers || { ...headers, Referer: url } }));
            }
          } catch (e) { console.log('Dulourd extracteur:', e.message); }
        }
      }
    }
  } catch (e) { console.log('Dulourd épisode inaccessible:', e.response ? `HTTP ${e.response.status}` : e.code || e.message); }
  console.log(`Dulourd ${epUrl}: ${streams.length} flux vidéo lisible(s)`);
  return streams;
}

module.exports = {
  prefix: 'dulourd:',
  catalogId: 'dulourd',
  catalogName: 'Dulourd',
  types: ['series'],
  genres: Object.keys(GENRES),
  catalog,
  meta,
  stream,
};
