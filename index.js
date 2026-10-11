app.get('/dbg', async (req, res) => {
  try {
    const u = new URL(req.query.u);
    if (!u.hostname.endsWith('coflix.wiki')) return res.status(400).send('refusé');
    const r = await axios.get(u.href, {
      timeout: 10000,
      responseType: 'text',
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', Referer: 'https://coflix.wiki/' },
    });
    const html = String(r.data);
    let out = html;
    if (req.query.q) {
      const re = new RegExp(req.query.q, 'gi');
      const found = [];
      let m;
      while ((m = re.exec(html)) && found.length < 40) {
        found.push(html.slice(Math.max(0, m.index - 250), m.index + 250).replace(/\s+/g, ' '));
      }
      out = found.join('\n\n----------\n\n');
    }
    res.type('text/plain').send(out || 'aucune correspondance');
  } catch (e) {
    res.status(500).send(String(e.message));
  }
});
