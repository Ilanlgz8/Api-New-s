import { NextResponse } from 'next/server';
import { withCache, CACHE_TTL } from '@/lib/cache';
import type { CryptoCoin } from '@/lib/cryptoTypes';

export const runtime = 'nodejs';

const COINS = [
  { symbol: 'BTCEUR', name: 'Bitcoin',  id: 'bitcoin'  },
  { symbol: 'ETHEUR', name: 'Ethereum', id: 'ethereum' },
  { symbol: 'SOLEUR', name: 'Solana',   id: 'solana'   },
  { symbol: 'XRPEUR', name: 'XRP',      id: 'xrp'      },
  { symbol: 'DOGEEUR',name: 'Dogecoin', id: 'dogecoin' },
];

type BinanceTicker = {
  symbol: string;
  lastPrice?: string;
  priceChangePercent?: string;
  highPrice?: string;
  lowPrice?: string;
  quoteVolume?: string;
};

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
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
          ? tickers.find((x: BinanceTicker) => x.symbol === coin.symbol) ?? {}
          : {};
          const sparkline = (klinesResults[i] as BinanceKline[]).map((k) => parseFloat(k[4]));

          const result: CryptoCoin = {
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

        return result;
      });
    });

    return NextResponse.json(data, {
      headers: { 'X-Cache': fromCache ? `HIT age=${age}s` : 'MISS' },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Binance API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}