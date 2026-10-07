// Extracteurs génériques pour les pages d'embed (Uqload, Vidmoly, Sendvid, Sibnet, etc.).
// Principe : télécharger la page, décompresser le JS "packed" éventuel, puis chercher les liens .m3u8/.mp4.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const VIDEO = /\.(m3u8|mp4|mkv|webm)(\?|$)/i;
const NOISE = /\.(jpe?g|png|webp|gif|svg|vtt|srt)(\?|$)/i;

// Décompresse le format eval(function(p,a,c,k,e,d){...}) (Dean Edwards packer), très courant sur les hébergeurs.
function unpackAll(src) {
  const re = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/gs;
  let out = '';
  for (const m of src.matchAll(re)) {
    let p = m[1];
    const a = Number(m[2]);
    let c = Number(m[3]);
    const k = m[4].split('|');
    const base = (n) => (n < a ? '' : base(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + base(c) + '\\b', 'g'), k[c]);
    out += '\n' + p.replace(/\\'/g, "'");
  }
  return out;
}

function candidates(text, pageUrl) {
  const t = text.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  const out = new Set();
  const add = (u) => {
    try {
      const abs = new URL(u, pageUrl).href;
      if (VIDEO.test(abs) && !NOISE.test(abs)) out.add(abs);
    } catch { /* URL invalide */ }
  };
  const patterns = [
    /file\s*:\s*["']([^"']+)["']/gi,
    /sources\s*:\s*\[\s*["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+)["']/gi,
    /property=["']og:video(?::\w+)?["'][^>]+content=["']([^"']+)["']/gi,
    /\bsrc\s*:\s*["']([^"']+)["']/gi,
    /https?:\/\/[^"'\s\\<>]+\.(?:m3u8|mp4)[^"'\s\\<>]*/gi,
  ];
  for (const re of patterns) for (const m of t.matchAll(re)) add(m[1] || m[0]);
  return [...out];
}

// Retourne [{ url, kind, headers }] (liste vide si rien n'est trouvé).
async function resolveEmbed(url, referer) {
  let origin;
  try { origin = new URL(url).origin; } catch { return []; }
  try {
    const { data } = await axios.get(url, {
      timeout: 7000,
      responseType: 'text',
      headers: { 'User-Agent': UA, Referer: referer || origin + '/' },
    });
    const html = typeof data === 'string' ? data : JSON.stringify(data);
    return candidates(html + '\n' + unpackAll(html), url)
      .slice(0, 3)
      .map((u) => ({
        url: u,
        kind: /\.m3u8/i.test(u) ? 'HLS' : 'MP4',
        headers: { Referer: origin + '/', 'User-Agent': UA },
      }));
  } catch {
    return [];
  }
}

module.exports = { resolveEmbed, unpackAll };
