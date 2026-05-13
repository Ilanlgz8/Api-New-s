'use client';

import React, { useState } from 'react';
import { Newspaper, ExternalLink, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import { useNews } from '@/hooks/useNews';
import { Card, CardHeader } from '@/components/ui/Card';
import { WidgetSkeleton, ErrorCard } from '@/components/ui/Skeleton';

type Country = 'fr' | 'us';

export const NewsWidget = React.memo(function NewsWidget() {
  const [country, setCountry] = useState<Country>('fr');
  const { data, error, isLoading } = useNews(country);

  return (
    <Card accent="cyan">
      <CardHeader title="Actualités" icon={<Newspaper size={14} />}>
        <div className="flex gap-2">
          {(['fr', 'us'] as Country[]).map((c) => (
            <button
              key={c}
              onClick={() => setCountry(c)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-sm font-semibold transition-all duration-300 border',
                country === c
                  ? 'bg-gradient-to-r from-cyan-500/20 to-blue-500/10 border-cyan-500/40 text-cyan-300'
                  : 'border-border/50 text-text-secondary hover:text-text-primary hover:border-border'
              )}
            >
              {c === 'fr' ? '🇫🇷' : '🌍'} {c.toUpperCase()}
            </button>
          ))}
        </div>
      </CardHeader>

      {isLoading ? (
        <WidgetSkeleton />
      ) : error ? (
        <ErrorCard message="Actualités indisponibles" />
      ) : (
        <div className="space-y-3 max-h-80 overflow-y-auto">
          {data?.articles?.slice(0, 8).map((article: any, i: number) => (
            <ArticleRow key={i} article={article} />
          ))}
        </div>
      )}
    </Card>
  );
});

const ArticleRow = React.memo(function ArticleRow({ article }: { article: any }) {
  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex gap-3 overflow-hidden rounded-xl border border-border/30 hover:border-cyan-500/40 bg-gradient-to-r from-cyan-500/5 to-transparent hover:from-cyan-500/10 p-3.5 transition-all duration-300 hover:shadow-lg hover:shadow-cyan-500/10"
    >
      {/* Top accent line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

      {/* Image */}
      {article.urlToImage && (
        <img
          src={article.urlToImage}
          alt=""
          className="w-16 h-16 object-cover rounded-lg flex-shrink-0 bg-gradient-to-br from-bg-hover to-bg-accent/50 border border-border/50 group-hover:border-border transition-all duration-300"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-cyan-300/80 truncate">{article.source?.name}</span>
          <span className="text-text-secondary/40">·</span>
          <span className="text-text-secondary/60 font-mono whitespace-nowrap">{formatTime(article.publishedAt)}</span>
        </div>
        <p className="text-sm leading-snug text-text-primary line-clamp-2 group-hover:text-white transition-colors duration-300 font-medium">
          {article.title?.replace(/\s*-\s*\S+$/, '')}
        </p>
      </div>

      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <ExternalLink size={14} className="text-cyan-400/60 group-hover:text-cyan-300 transition-colors duration-300" />
      </div>
    </a>
  );
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diff < 60) return `il y a ${diff}min`;
  if (diff < 1440) return `il y a ${Math.round(diff / 60)}h`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
