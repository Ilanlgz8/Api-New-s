import { NextResponse } from 'next/server';
import { withCache, CACHE_TTL } from '@/lib/cache';

export const runtime = 'nodejs';

const COINS = [
  { symbol: 'BTCEUR', name: 'Bitcoin',  id: 'bitcoin'  },
  { symbol: 'ETHEUR', name: 'Ethereum', id: 'ethereum' },
  { symbol: 'SOLEUR', name: 'Solana',   id: 'solana'   },
  { symbol: 'XRPEUR', name: 'XRP',      id: 'xrp'      },
  { symbol: 'DOGEEUR',name: 'Dogecoin', id: 'dogecoin' },
];

export async function GET() {
  try {
    const { data, fromCache, age } = await withCache('crypto:binance', CACHE_TTL.crypto, async () => {

      const symbolsParam = encodeURIComponent(JSON.stringify(COINS.map(c => c.symbol)));

      const [tickersRes, klinesResults] = await Promise.all([
        fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`),
        Promise.all(
          COINS.map(c =>
            fetch(`https://api.binance.com/api/v3/klines?symbol=${c.symbol}&interval=4h&limit=42`)
              .then(r => r.ok ? r.json() : [])
              .catch(() => [])
          )
        ),
      ]);

      if (!tickersRes.ok) {
        const err = await tickersRes.text();
        throw new Error(`Binance ${tickersRes.status}: ${err}`);
      }

      const tickers = await tickersRes.json();

      return COINS.map((coin, i) => {
        const t = Array.isArray(tickers)
          ? tickers.find((x: any) => x.symbol === coin.symbol) ?? {}
          : {};
        const sparkline = (klinesResults[i] as any[]).map((k: any) => parseFloat(k[4]));

        return {
          id:                           coin.id,
          symbol:                       coin.symbol.replace('EUR', '').toLowerCase(),
          name:                         coin.name,
          image:                        `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons/128/color/${coin.id}.png`,
          current_price:                parseFloat(t.lastPrice ?? '0'),
          price_change_percentage_24h:  parseFloat(t.priceChangePercent ?? '0'),
          high_24h:                     parseFloat(t.highPrice ?? '0'),
          low_24h:                      parseFloat(t.lowPrice ?? '0'),
          total_volume:                 parseFloat(t.quoteVolume ?? '0'),
          sparkline_in_7d:              { price: sparkline },
        };
      });
    });

    return NextResponse.json(data, {
      headers: { 'X-Cache': fromCache ? `HIT age=${age}s` : 'MISS' },
    });
  } catch (error: any) {
    console.error('Binance API error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}