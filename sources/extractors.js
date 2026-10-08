// Extracteurs génériques pour les pages d'embed (Uqload, Vidmoly, Sendvid, Sibnet, etc.).
// Principe : télécharger la page, décompresser le JS "packed" éventuel, puis chercher les liens .m3u8/.mp4.
const axios = require('axios');
const https = require('https');

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
  if (/href="https?:\/\/[^"]+\/d\/[a-z0-9]+_[a-z]"/i.test(String(html))) return xfsDownload(html, url);
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
    return xfsDownload(html, url);
  }
  const origin = new URL(ok.t).origin;
  return ok.f.slice(0, 3).map((link) => ({
    url: link,
    kind: /\.m3u8/i.test(link) ? 'HLS' : 'MP4',
    headers: { Referer: origin + '/', 'User-Agent': UA },
  }));
}

// Pages XFileSharing : le lien "Download" mène à un formulaire (op=download_orig) dont l'envoi donne le fichier mp4.
// Le lien obtenu est lié à l'adresse IP qui a envoyé le formulaire : c'est pourquoi il doit passer par le relais.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function xfsAttemptWith(dl, pageUrl, agent) {
  const origin = new URL(dl).origin;
  const page = await axios.get(dl, {
    timeout: 4000, maxContentLength: 1500000, responseType: 'text', httpsAgent: agent,
    headers: { 'User-Agent': UA, Referer: pageUrl },
  });
  const cookie = (page.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const h = String(page.data);
  const form = h.match(/<form[^>]*method=["']?post["']?[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return { body: h, nolink: true };
  const params = new URLSearchParams();
  for (const m of form[1].matchAll(/<input[^>]+>/gi)) {
    const name = m[0].match(/name=["']([^"']+)["']/i);
    const val = m[0].match(/value=["']([^"']*)["']/i);
    if (name) params.append(name[1], val ? val[1] : '');
  }
  const headers = { 'User-Agent': UA, Referer: dl, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.Cookie = cookie;
  const r = await axios.post(dl, params.toString(), {
    maxRedirects: 0, validateStatus: () => true, timeout: 6000, maxContentLength: 1500000, responseType: 'text', headers, httpsAgent: agent,
  });
  const body = String(r.data || '');
  const link = r.headers.location || candidates(body, dl)[0];
  console.log(`  ↳ TÉLÉCHARGEMENT ${dl} : HTTP ${r.status}, ${link ? 'lien obtenu' : /security error/i.test(body) ? 'Security error' : 'pas de lien'}`);
  return { body, link: link ? new URL(link, dl).href : null, origin };
}

// Le code de validation du formulaire est lié à l'adresse IP de départ : on envoie la page ET le formulaire
// sur la même connexion TCP, pour que le serveur voie toujours la même adresse.
async function xfsAttempt(dl, pageUrl) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    return await xfsAttemptWith(dl, pageUrl, agent);
  } finally {
    agent.destroy();
  }
}

// Le site limite le nombre de requêtes (HTTP 429 quand on en envoie trop en parallèle) : tentatives une par une,
// en alternant HD / Normal, avec arrêt immédiat si le site répond 429, et mémorisation du résultat.
const xfsCache = new Map(); // adresse de la page -> { links, until }

async function xfsDownload(html, pageUrl) {
  const hit = xfsCache.get(pageUrl);
  if (hit && Date.now() < hit.until) return hit.links;

  const all = [...String(html).matchAll(/href="(https?:\/\/[^"]+\/d\/[a-z0-9]+_[a-z])"/gi)].map((m) => m[1]);
  const hd = all.find((l) => /_h$/.test(l));
  const normal = all.find((l) => /_n$/.test(l)) || all.find((l) => !/_h$/.test(l));
  const order = [hd, normal, hd, normal, hd, normal].filter(Boolean);

  let result = [];
  for (let i = 0; i < order.length; i++) {
    try {
      const res = await xfsAttempt(order[i], pageUrl);
      if (res.link) {
        result = [{ url: res.link, kind: 'MP4', headers: { Referer: res.origin + '/', 'User-Agent': UA } }];
        break;
      }
      if (!/security error/i.test(res.body)) {
        console.log(`  ↳ EXTRAIT RÉPONSE : ${res.body.replace(/\s+/g, ' ').slice(0, 1200)}`);
        break;
      }
    } catch (e) {
      const status = e.response && e.response.status;
      console.log(`  ↳ TÉLÉCHARGEMENT ${order[i]} : ${status ? 'HTTP ' + status : e.code || e.message}`);
      if (status === 429) break; // trop de requêtes : inutile d'insister
    }
    await sleep(250);
  }
  // Succès gardé 10 min ; échec gardé 45 s (évite de marteler le site quand Stremio redemande).
  xfsCache.set(pageUrl, { links: result, until: Date.now() + (result.length ? 600000 : 45000) });
  return result;
}

// Dailymotion : l'API publique "metadata" donne un flux HLS lisible dans n'importe quel lecteur.
const DAILYMOTION = /(^|\.)(dailymotion\.com|dai\.ly)$/i;
function dailymotionId(url) {
  const u = new URL(url);
  const v = u.searchParams.get('video');
  if (v) return v;
  const m = u.pathname.match(/\/(?:embed\/)?video\/([a-z0-9]+)/i) || (u.hostname === 'dai.ly' ? u.pathname.match(/^\/([a-z0-9]+)/i) : null);
  return m ? m[1] : null;
}
async function resolveDailymotion(url) {
  const id = dailymotionId(url);
  if (!id) return [];
  const headers = { 'User-Agent': UA, Referer: 'https://www.dailymotion.com/', Origin: 'https://www.dailymotion.com' };
  const { data } = await axios.get(`https://www.dailymotion.com/player/metadata/video/${id}`, { timeout: 5000, headers });
  const auto = data && data.qualities && data.qualities.auto;
  const hls = auto && (auto.find((q) => /mpegurl/i.test(q.type || '')) || auto[0]);
  if (!hls || !hls.url) {
    const why = data && data.error ? `${data.error.type || ''} ${data.error.title || ''}`.trim() : 'aucun flux';
    console.log(`  ↳ Dailymotion ${id} : ${why}`);
    return [];
  }
  return [{ url: hls.url, kind: 'HLS', headers }];
}

// Retourne [{ url, kind, headers }] (liste vide si rien n'est trouvé).
async function resolveEmbed(url, referer) {
  let origin;
  try { origin = new URL(url).origin; } catch { return []; }
  try {
    if (DAILYMOTION.test(new URL(url).hostname)) return await resolveDailymotion(url);
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
