// sources/frenchstream.js
const BASE = 'https://french-stream.net';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const H = { 'user-agent': UA, referer: BASE + '/' };

async function get(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error('french-stream ' + r.status);
  return r.text();
}

async function search(title) {
  const body = new URLSearchParams({ do: 'search', subaction: 'search', story: title });
  const html = await get(BASE + '/index.php?do=search', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const out = [];
  const re = /<a[^>]+href="(?:https:\/\/french-stream\.net\/)?(index\.php\?newsid=\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length > 1) out.push({ url: BASE + '/' + m[1], name });
  }
  return out;
}

function extractEmbeds(html) {
  const found = new Set();
  const re = /(?:<iframe[^>]+src|data-(?:src|url|link|player|embed|video)|"(?:file|link|url|embed)")\s*[=:]\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1].replace(/\\\//g, '/');
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:\/\//.test(u)) continue;
    if (/youtube|youtu\.be|tmdb|histats|\.(jpg|png|webp|gif|css|js)(\?|$)/i.test(u)) continue;
    found.add(u);
  }
  return [...found];
}

// Films : renvoie la liste des embeds de la fiche la plus proche du titre
async function getEmbeds(title) {
  const results = await search(title);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = results.find((r) => norm(r.name).includes(norm(title))) || results[0];
  if (!hit) return [];
  const html = await get(hit.url);
  return extractEmbeds(html);
}

module.exports = { search, extractEmbeds, getEmbeds, get };
