// Vercel Serverless Function — proxies Yahoo Finance v8 chart API
// Deployed at /api/yahoo?symbol=AAPL&range=3mo&interval=1d
// Runs server-side on Vercel Node.js — Yahoo never 403s server requests.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, range = '3mo', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };

  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;

  // Try query1 then query2
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}${path}`, { headers: HEADERS });
      if (r.ok) {
        const data = await r.json();
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        return res.status(200).json(data);
      }
    } catch (_) {}
  }

  return res.status(502).json({ error: 'Yahoo Finance unavailable' });
}