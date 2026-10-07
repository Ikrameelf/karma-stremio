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

// Méthode "pass_md5" (Doodstream et clones) : la page publie un chemin /pass_md5/... qui donne la base du lien vidéo.
const DOOD = /(^|\.)(dood|d0o0d|d000d|ds2play|doodstream|dooood|dsvplay)[\w-]*\./i;
async function passMd5(html, pageUrl) {
  const u = new URL(pageUrl);
  const md5 = String(html).match(/\/pass_md5\/[^'"\s]+/);
  if (!md5) return [];
  const token = md5[0].split('/').pop();
  const { data: base } = await axios.get(u.origin + md5[0], {
    timeout: 4000, responseType: 'text', headers: { 'User-Agent': UA, Referer: pageUrl },
  });
  if (!/^https?:/.test(String(base))) return [];
  const rand = Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  return [{ url: `${String(base).trim()}${rand}?token=${token}&expiry=${Date.now()}`, kind: 'MP4', headers: { Referer: u.origin + '/', 'User-Agent': UA } }];
}
async function resolveDood(url) {
  const u = new URL(url);
  const embed = `${u.origin}/e/${u.pathname.split('/').filter(Boolean).pop()}`;
  const { data: html } = await axios.get(embed, { timeout: 4000, responseType: 'text', headers: { 'User-Agent': UA, Referer: u.origin + '/' } });
  return passMd5(html, embed);
}

// Pages de téléchargement type XFileSharing (ex. engifuosi.com/d/<code>.html) : on devine l'adresse du lecteur
// à partir du code du fichier, sur le même site et sur les hôtes cités dans la page (ex. tokvoy.com).
async function tryXfs(url, html, referer) {
  const u = new URL(url);
  const m = u.pathname.match(/\/(?:d|f|e|v)\/([a-z0-9]{8,})/i);
  if (!m) return [];
  const code = m[1];
  const hosts = new Set([u.origin]);
  for (const h of String(html).matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\/d\/[a-z0-9]+/gi)) {
    if (!/^(cdnjs|www\.w3)/i.test(h[1])) hosts.add('https://' + h[1]);
  }
  const paths = [`/e/${code}`, `/v/${code}`, `/embed-${code}.html`];
  const tries = [...hosts].flatMap((h) => paths.map((p) => h + p));
  const results = await Promise.all(tries.map(async (t) => {
    try {
      const { data } = await axios.get(t, {
        timeout: 4000, maxContentLength: 1500000, responseType: 'text',
        headers: { 'User-Agent': UA, Referer: referer || u.origin + '/' },
      });
      const h = String(data);
      const f = candidates(h + '\n' + unpackAll(h), t);
      console.log(`  ↳ essai ${t} : ${f.length} lien(s)`);
      return f.length ? { t, f } : null;
    } catch (e) {
      console.log(`  ↳ essai ${t} : ${e.response ? 'HTTP ' + e.response.status : e.code || e.message}`);
      return null;
    }
  }));
  const ok = results.find(Boolean);
  if (!ok) {
    await probeDownload(html, url);
    return [];
  }
  const origin = new URL(ok.t).origin;
  return ok.f.slice(0, 3).map((link) => ({
    url: link,
    kind: /\.m3u8/i.test(link) ? 'HLS' : 'MP4',
    headers: { Referer: origin + '/', 'User-Agent': UA },
  }));
}

// Diagnostic : ouvre le lien de téléchargement proposé par la page (HD de préférence) et journalise ce qu'il contient.
async function probeDownload(html, pageUrl) {
  const links = [...String(html).matchAll(/href="(https?:\/\/[^"]+\/d\/[a-z0-9]+_[a-z])"/gi)].map((m) => m[1]);
  const dl = links.find((l) => /_h$/.test(l)) || links[0];
  if (!dl) return;
  try {
    const r = await axios.get(dl, {
      timeout: 4000, maxContentLength: 1500000, responseType: 'text', validateStatus: () => true,
      headers: { 'User-Agent': UA, Referer: pageUrl },
    });
    const h = String(r.data);
    console.log(`  ↳ TÉLÉCHARGEMENT ${dl} : HTTP ${r.status}, ${h.length} octets, serveur ${r.headers.server || '?'}`);
    console.log(`  ↳ EXTRAIT TÉLÉCHARGEMENT : ${h.replace(/\s+/g, ' ').slice(0, 1800)}`);
  } catch (e) {
    console.log(`  ↳ TÉLÉCHARGEMENT ${dl} : ${e.code || e.message}`);
  }
}

// Retourne [{ url, kind, headers }] (liste vide si rien n'est trouvé).
async function resolveEmbed(url, referer) {
  let origin;
  try { origin = new URL(url).origin; } catch { return []; }
  try {
    if (DOOD.test(new URL(url).hostname)) return await resolveDood(url);
    const { data } = await axios.get(url, {
      timeout: 4000,
      maxContentLength: 1500000,
      responseType: 'text',
      headers: { 'User-Agent': UA, Referer: referer || origin + '/' },
    });
    const html = typeof data === 'string' ? data : JSON.stringify(data);
    const found = candidates(html + '\n' + unpackAll(html), url);
    if (!found.length && /\/pass_md5\//.test(html)) {
      const viaMd5 = await passMd5(html, url);
      if (viaMd5.length) return viaMd5;
    }
    if (!found.length) {
      const viaXfs = await tryXfs(url, html, referer);
      if (viaXfs.length) return viaXfs;
    }
    if (!found.length) {
      console.log(`  ↳ ${origin} : page lue (${html.length} octets) mais aucun lien vidéo trouvé`);
      console.log(`  ↳ URL : ${url}`);
      console.log(`  ↳ EXTRAIT : ${html.replace(/\s+/g, ' ').slice(0, 2500)}`);
    }
    return found
      .slice(0, 3)
      .map((u) => ({
        url: u,
        kind: /\.m3u8/i.test(u) ? 'HLS' : 'MP4',
        headers: { Referer: origin + '/', 'User-Agent': UA },
      }));
  } catch (err) {
    const why = err.response
      ? `HTTP ${err.response.status} (serveur : ${err.response.headers['server'] || '?'})`
      : err.code || err.message;
    console.log(`  ↳ ${origin} : ÉCHEC ${why}`);
    return [];
  }
}

module.exports = { resolveEmbed, unpackAll };
