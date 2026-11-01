// Tentative de provider pour Elisa's Addictions (site Wix, rendu client-side).
// ATTENTION : le site est une SPA Wix, le scraping serveur est très fragile.
const axios = require('axios');
const cheerio = require('cheerio');
const { resolveEmbed } = require('./extractors');
const { playable } = require('./proxy');

const BASE = 'https://www.elisasaddictions.fr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const http = axios.create({ timeout: 20000, headers: { 'User-Agent': UA } });

// Mapping slug série -> chemin sur le site (à compléter manuellement si besoin)
const SERIES_SLUGS = {};

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '').trim();
}

async function findStreams(seriesPath, epNum) {
  // On ne peut pas scraper Wix de façon fiable côté serveur.
  // Ce module est un squelette : il tente de récupérer la page épisode et d'extraire des iframes.
  const last = String(seriesPath || '').split('/').filter(Boolean).pop();
  if (!last || !epNum) return [];
  const slug = SERIES_SLUGS[last] || slugify(last);
  const epUrl = `${BASE}/${slug}/%C3%A9pisode-${String(epNum).padStart(2, '0')}`;
  let html;
  try {
    html = (await http.get(epUrl, { responseType: 'text' })).data;
  } catch (e) {
    console.log(`Elisa ${epUrl} : ${e.response ? 'HTTP ' + e.response.status : e.code || e.message}`);
    return [];
  }
  const $ = cheerio.load(html);
  const found = new Set();
  $('iframe').each((_, el) => {
    const s = $(el).attr('src') || $(el).attr('data-src');
    if (s && /^https?:/.test(s)) found.add(s);
  });
  (html.match(/https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)[^"'\s\\<>]*/gi) || []).forEach((u) => found.add(u));
  const streams = [];
  for (const url of found) {
    const links = await resolveEmbed(url, epUrl);
    if (links.length) links.forEach((l) => streams.push(playable({ name: 'Elisa', title: `Direct (${l.kind})`, url: l.url, headers: l.headers })));
    else streams.push({ name: 'Elisa', title: 'Ouvrir dans le navigateur', externalUrl: url });
  }
  console.log(`Elisa ${epUrl} : ${streams.length} flux`);
  return streams;
}

module.exports = { findStreams };