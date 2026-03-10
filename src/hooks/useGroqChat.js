import { useState, useCallback, useRef } from 'react';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.1-8b-instant';

function buildSystemPrompt(quotes) {
  const holdings = [
    { symbol: 'NVDA', name: 'NVIDIA Corp',   shares: 12, avgCost: 412.50, sector: 'Technology' },
    { symbol: 'AAPL', name: 'Apple Inc',     shares: 25, avgCost: 178.30, sector: 'Technology' },
    { symbol: 'MSFT', name: 'Microsoft',     shares:  8, avgCost: 335.00, sector: 'Technology' },
    { symbol: 'JPM',  name: 'JPMorgan',      shares: 15, avgCost: 172.40, sector: 'Financials' },
    { symbol: 'AMZN', name: 'Amazon',        shares:  6, avgCost: 138.90, sector: 'Consumer'   },
    { symbol: 'TSLA', name: 'Tesla',         shares: 20, avgCost: 230.00, sector: 'Consumer'   },
  ];

  let totalValue = 0, totalCost = 0;
  const rows = holdings.map(h => {
    const price = quotes?.[h.symbol]?.price || h.avgCost;
    const val   = price * h.shares;
    const pl    = (price - h.avgCost) * h.shares;
    const plPct = ((price - h.avgCost) / h.avgCost) * 100;
    totalValue += val;
    totalCost  += h.shares * h.avgCost;
    return `| ${h.symbol} | ${h.name} | ${h.shares} | $${h.avgCost.toFixed(2)} | $${price.toFixed(2)} | ${plPct >= 0 ? '+' : ''}${plPct.toFixed(1)}% | ${pl >= 0 ? '+' : ''}$${Math.abs(pl).toFixed(0)} |`;
  });
  const totalPL    = totalValue - totalCost;
  const totalPLPct = ((totalPL / totalCost) * 100).toFixed(2);

  return `You are ARIA, an elite AI investment analyst.

## Live Portfolio
| Symbol | Name | Shares | Avg Cost | Price | Return | P&L |
|--------|------|--------|----------|-------|--------|-----|
${rows.join('\n')}
Total: $${totalValue.toFixed(0)} | P&L: ${totalPL >= 0 ? '+' : ''}$${Math.abs(totalPL).toFixed(0)} (${totalPLPct}%)

## Format Rules
- Use ## headers, tables, - bullets, **bold**, > blockquotes
- Be direct, data-driven, reference specific numbers
- Give clear buy/sell/hold verdicts when asked`;
}

const WELCOME = {
  role: 'assistant',
  content: `## Welcome to ARIA 👋

I'm your **Advanced Real-time Investment Assistant** — powered by Groq LLM.

- 📊 **Portfolio Analysis** — risk, allocation, P&L
- 🔍 **Stock Research** — valuations, catalysts
- ⚖️ **Comparisons** — side-by-side with tables
- 📈 **Strategy** — rebalancing, entry/exit levels

> Try: *"Full portfolio risk analysis"* or *"Compare NVDA vs AMD"*`,
};

export function useGroqChat(quotes) {
  const [messages,    setMessages]    = useState([WELCOME]);
  const [isStreaming, setIsStreaming] = useState(false);

  const abortRef   = useRef(null);
  const bufferRef  = useRef('');

  // KEY DESIGN: during streaming we NEVER call setMessages.
  // Instead we expose a ref that ChatPanel reads directly via DOM.
  // setMessages is only called TWICE per response:
  //   1. At start: add user msg + empty placeholder
  //   2. At end:   fill placeholder with final text
  // This means ZERO React re-renders during streaming → no crash.
  const streamingDomRef = useRef(null); // ChatPanel registers its streaming div here

  const sendMessage = useCallback(async (userText) => {
    if (!userText.trim() || isStreaming) return;

    const apiKey = process.env.REACT_APP_GROQ_API_KEY;
    if (!apiKey || apiKey === 'your_groq_api_key_here') {
      setMessages(prev => [...prev,
        { role: 'user', content: userText },
        { role: 'assistant', content: '## ⚠️ API Key Missing\n\nAdd to `.env`:\n```\nREACT_APP_GROQ_API_KEY=your_key\n```\nGet free key at [console.groq.com](https://console.groq.com)' },
      ]);
      return;
    }

    const history = [...messages, { role: 'user', content: userText }];
    bufferRef.current = '';

    // ONLY state update #1 — add user message + streaming placeholder
    setMessages([...history, { role: 'assistant', content: '', streaming: true }]);
    setIsStreaming(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch(GROQ_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        signal:  abortRef.current.signal,
        body: JSON.stringify({
          model: GROQ_MODEL, stream: true, max_tokens: 600, temperature: 0.7,
          messages: [
            { role: 'system', content: buildSystemPrompt(quotes) },
            ...history.map(m => ({ role: m.role, content: m.content })),
          ],
        }),
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error?.message || `HTTP ${res.status}`);
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let chunkCount = 0;

      loop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') break loop;
          try {
            const delta = JSON.parse(raw).choices?.[0]?.delta?.content;
            if (delta) {
              bufferRef.current += delta;
              chunkCount++;
              // Write directly to DOM — ZERO React involvement
              if (streamingDomRef.current) {
                streamingDomRef.current.insertAdjacentText('beforeend', delta);
                // Yield main thread every 8 chunks to prevent browser freeze
                if (chunkCount % 8 === 0) {
                  await new Promise(r => setTimeout(r, 0));
                }
                // Auto-scroll throttled
                if (bufferRef.current.length % 60 < delta.length) {
                  const el = streamingDomRef.current.closest('.aria-msgs-scroll');
                  if (el) el.scrollTop = el.scrollHeight;
                }
              }
            }
          } catch (_) {}
        }
      }

      // ONLY state update #2 — finalize with full text (triggers one re-render)
      const finalText = bufferRef.current;
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', content: finalText, streaming: false };
        return copy;
      });

    } catch (err) {
      if (err.name === 'AbortError') {
        const partial = bufferRef.current;
        setMessages(prev => {
          const copy = [...prev];
          if (copy[copy.length - 1]?.streaming) {
            copy[copy.length - 1] = { role: 'assistant', content: partial || '*(stopped)*', streaming: false };
          }
          return copy;
        });
      } else {
        setMessages(prev => [
          ...prev.filter(m => !(m.streaming && !m.content)),
          { role: 'assistant', content: `## ❌ Error\n\n**${err.message}**\n\nCheck your API key and connection.` },
        ]);
      }
    } finally {
      setIsStreaming(false);
      bufferRef.current = '';
    }
  }, [messages, isStreaming, quotes]);

  const stopStreaming = useCallback(() => abortRef.current?.abort(), []);

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    bufferRef.current = '';
    setMessages([WELCOME]);
    setIsStreaming(false);
  }, []);

  return { messages, isStreaming, sendMessage, stopStreaming, clearChat, streamingDomRef };
}
