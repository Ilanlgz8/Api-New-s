'use client';

import React from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { clsx } from 'clsx';
import { useCrypto } from '@/hooks/useCrypto';
import { Card, CardHeader } from '@/components/ui/Card';
import { WidgetSkeleton, ErrorCard } from '@/components/ui/Skeleton';
import type { CryptoCoin } from '@/lib/cryptoTypes';

export const CryptoWidget = React.memo(function CryptoWidget() {
  const { data, error, isLoading } = useCrypto();

  if (isLoading) return <WidgetSkeleton />;
  if (error) return <ErrorCard message="Données crypto indisponibles" />;

  return (
    <Card accent="gold">
      <CardHeader title="Crypto" icon={<span className="text-accent-gold">₿</span>} />
      <div className="space-y-2">
        {data?.map((coin: CryptoCoin) => (
          <CoinRow key={coin.id} coin={coin} />
        ))}
      </div>
    </Card>
  );
});

const CoinRow = React.memo(function CoinRow({ coin }: { coin: CryptoCoin }) {
  const change = coin.price_change_percentage_24h;
  const isUp = change >= 0;
  const sparkData = coin.sparkline_in_7d?.price?.map((p: number, i: number) => ({ v: p, i })) ?? [];

  return (
    <div className={clsx(
      'group bg-gradient-to-r border rounded-xl p-3.5 transition-all duration-300 hover:shadow-lg',
      isUp 
        ? 'from-green-500/5 to-transparent hover:from-green-500/10 border-green-500/20 hover:border-green-500/40 hover:shadow-green-500/10' 
        : 'from-red-500/5 to-transparent hover:from-red-500/10 border-red-500/20 hover:border-red-500/40 hover:shadow-red-500/10'
    )}>
      <div className="flex items-center gap-3.5">
        {/* Icon */}
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-bg-hover to-bg-accent/50 border border-border/50 flex items-center justify-center flex-shrink-0 overflow-hidden group-hover:border-border transition-colors">
          <img
            src={`https://assets.coincap.io/assets/icons/${coin.symbol}@2x.png`}
            alt={coin.name}
            className="w-8 h-8 rounded-full"
            onError={(e) => {
              const target = e.currentTarget;
              target.style.display = 'none';
              if (target.parentElement) {
                target.parentElement.innerHTML = `<span class="text-sm font-bold text-yellow-400">${coin.symbol.substring(0, 1).toUpperCase()}</span>`;
              }
            }}
          />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-text-primary text-sm">{coin.symbol.toUpperCase()}</span>
            <span className={clsx(
              'text-xs font-mono font-bold px-2 py-0.5 rounded-full',
              isUp ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'
            )}>
              {isUp ? '+' : ''}{change.toFixed(1)}%
            </span>
          </div>
          <div className="text-text-secondary text-xs">{coin.name}</div>
        </div>

        {/* Chart */}
        {sparkData.length > 0 && (
          <div className="w-20 h-10 flex-shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkData}>
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke={isUp ? '#22c55e' : '#ef4444'}
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={true}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Price */}
        <div className="text-right min-w-[80px] flex-shrink-0">
          <div className="font-mono text-sm font-semibold text-text-primary">
            {coin.current_price.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: coin.current_price < 1 ? 4 : 2 })} €
          </div>
          <div className="text-xs font-mono text-text-secondary/60">
            Vol {formatLarge(coin.total_volume ?? 0)}
          </div>
        </div>
      </div>
    </div>
  );
});

function formatLarge(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T€`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B€`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M€`;
  return `${(n / 1e3).toFixed(0)}k€`;
}
