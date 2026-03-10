import { useState, useEffect, useCallback, useRef } from 'react';

// ── Finnhub — for live quotes (free tier works fine) ───────────────────────
const FINNHUB = 'https://finnhub.io/api/v1';
function getKey() { return process.env.REACT_APP_FINNHUB_KEY || ''; }

// ── Yahoo Finance — for historical candles via serverless proxy ─────────────

export const ALL_SYMBOLS = [
  'AAPL', 'NVDA', 'MSFT', 'GOOGL', 'AMZN',
  'META', 'TSLA', 'JPM',  'AMD',   'NFLX',
];

export const INDEX_SYMBOLS = [
  { symbol: 'SPY',  name: 'S&P 500' },
  { symbol: 'QQQ',  name: 'NASDAQ'  },
  { symbol: 'DIA',  name: 'DOW'     },
  { symbol: 'VIXY', name: 'VIX'     },
];

export const PORTFOLIO_HOLDINGS = [
  { symbol: 'NVDA', name: 'NVIDIA Corp',   shares: 12, avgCost: 412.50, sector: 'Technology' },
  { symbol: 'AAPL', name: 'Apple Inc',     shares: 25, avgCost: 178.30, sector: 'Technology' },
  { symbol: 'MSFT', name: 'Microsoft',     shares:  8, avgCost: 335.00, sector: 'Technology' },
  { symbol: 'JPM',  name: 'JPMorgan',      shares: 15, avgCost: 172.40, sector: 'Financials' },
  { symbol: 'AMZN', name: 'Amazon',        shares:  6, avgCost: 138.90, sector: 'Consumer'   },
  { symbol: 'TSLA', name: 'Tesla',         shares: 20, avgCost: 230.00, sector: 'Consumer'   },
];

export const SECTOR_COLORS = {
  Technology: '#7eb8f7',
  Financials: '#58e8a2',
  Consumer:   '#f0c060',
  Healthcare: '#c084fc',
  Energy:     '#f05070',
};

const STOCK_NAMES = {
  AAPL: 'Apple Inc',       NVDA: 'NVIDIA Corp',  MSFT: 'Microsoft',
  GOOGL: 'Alphabet',       AMZN: 'Amazon',       META: 'Meta Platforms',
  TSLA: 'Tesla',           JPM: 'JPMorgan',      AMD: 'AMD',
  NFLX: 'Netflix',         SPY: 'S&P 500 ETF',   QQQ: 'NASDAQ ETF',
  DIA: 'DOW ETF',          VIXY: 'VIX ETF',
};

// ── Finnhub: live quote ────────────────────────────────────────────────────
async function fetchQuote(symbol, key) {
  const res = await fetch(`${FINNHUB}/quote?symbol=${symbol}&token=${key}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const d = await res.json();
  if (!d.c || d.c === 0) return null;
  return {
    symbol, name: STOCK_NAMES[symbol] || symbol,
    price: d.c, change: d.d, changePct: d.dp,
    high: d.h, low: d.l, open: d.o, prevClose: d.pc,
  };
}

// ── Yahoo Finance: historical candles (free, no key) ──────────────────────
const YF_PERIOD_MAP = {
  '1W': { range: '5d',  interval: '60m' },
  '1M': { range: '1mo', interval: '1d'  },
  '3M': { range: '3mo', interval: '1d'  },
  '6M': { range: '6mo', interval: '1d'  },
  '1Y': { range: '1y',  interval: '1wk' },
  '2Y': { range: '2y',  interval: '1wk' },
};

// Always use our own serverless proxy — works both locally (via CRA proxy) and on Vercel
function buildYahooUrl(symbol, range, interval) {
  return `/api/yahoo?symbol=${symbol}&range=${range}&interval=${interval}`;
}

async function fetchYahooCandles(symbol, period) {
  const cfg = YF_PERIOD_MAP[period] || YF_PERIOD_MAP['3M'];
  const url  = buildYahooUrl(symbol, cfg.range, cfg.interval);

  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);

  const json   = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('No chart data in response');

  const timestamps = result.timestamp;
  const quote      = result.indicators?.quote?.[0];
  if (!timestamps?.length || !quote) throw new Error('Empty chart data');

  const adjClose = result.indicators?.adjclose?.[0]?.adjclose;

  return timestamps.map((ts, i) => {
    const close = adjClose?.[i] ?? quote.close?.[i];
    if (close == null || close === 0) return null;
    return {
      ts:     ts * 1000,
      date:   new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      close:  +close.toFixed(2),
      open:   quote.open?.[i]   != null ? +quote.open[i].toFixed(2)   : null,
      high:   quote.high?.[i]   != null ? +quote.high[i].toFixed(2)   : null,
      low:    quote.low?.[i]    != null ? +quote.low[i].toFixed(2)    : null,
      volume: quote.volume?.[i] ?? null,
    };
  }).filter(Boolean);
}

// ── Main hook ──────────────────────────────────────────────────────────────
export function useStockData() {
  const [quotes,      setQuotes]      = useState({});
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Cache in ref — never triggers re-renders, keeps loadHistory stable
  const cacheRef = useRef({});

  const loadQuotes = useCallback(async () => {
    const key = getKey();
    if (!key) { setError('no_key'); setLoading(false); return; }

    const results = {};
    for (const sym of ALL_SYMBOLS) {
      try {
        const q = await fetchQuote(sym, key);
        if (q) results[sym] = q;
        await new Promise(r => setTimeout(r, 130));
      } catch (e) {
        console.warn(`Quote ${sym}:`, e.message);
      }
    }

    if (Object.keys(results).length > 0) {
      setQuotes(results);
      setLastUpdated(new Date());
      setError(null);
    } else {
      setError('fetch_failed');
    }
    setLoading(false);
  }, []);

  // Stable loadHistory — empty deps, cache in ref
  const loadHistory = useCallback(async (symbol, period = '3M') => {
    const cacheKey = `${symbol}-${period}`;
    if (cacheRef.current[cacheKey]) return cacheRef.current[cacheKey];

    try {
      const data = await fetchYahooCandles(symbol, period);
      if (data.length > 0) {
        cacheRef.current[cacheKey] = data;
      }
      return data;
    } catch (e) {
      console.error(`History ${symbol}/${period}:`, e.message);
      throw e; // re-throw so StockChart can show the real error
    }
  }, []); // stable — no deps

  useEffect(() => {
    loadQuotes();
    const iv = setInterval(loadQuotes, 120_000);
    return () => clearInterval(iv);
  }, []); // eslint-disable-line

  return { quotes, loading, error, lastUpdated, loadHistory, refresh: loadQuotes };
}

// ── Index hook ─────────────────────────────────────────────────────────────
export function useIndexData() {
  const [indices, setIndices] = useState([]);

  useEffect(() => {
    const key = getKey();
    if (!key) return;

    const load = async () => {
      const out = [];
      for (const { symbol, name } of INDEX_SYMBOLS) {
        try {
          const q = await fetchQuote(symbol, key);
          if (q) out.push({
            symbol, name,
            value:     q.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            change:    q.change,
            changePct: q.changePct,
            up:        q.change >= 0,
          });
          await new Promise(r => setTimeout(r, 130));
        } catch (e) {
          console.warn(`Index ${symbol}:`, e.message);
        }
      }
      setIndices(out);
    };
    load();
  }, []); // eslint-disable-line

  return { indices };
}
