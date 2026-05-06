'use client';

import dynamic from 'next/dynamic';
import { Activity } from 'lucide-react';

// Chargement dynamique pour éviter l'hydration mismatch et gagner en perf
const WeatherWidget = dynamic(() => import('@/components/widgets/WeatherWidget').then(m => ({ default: m.WeatherWidget })), { ssr: false });
const CryptoWidget = dynamic(() => import('@/components/widgets/CryptoWidget').then(m => ({ default: m.CryptoWidget })), { ssr: false });
const EnergyWidget = dynamic(() => import('@/components/widgets/EnergyWidget').then(m => ({ default: m.EnergyWidget })), { ssr: false });
const FootballWidget = dynamic(() => import('@/components/widgets/FootballWidget').then(m => ({ default: m.FootballWidget })), { ssr: false });
const NewsWidget = dynamic(() => import('@/components/widgets/NewsWidget').then(m => ({ default: m.NewsWidget })), { ssr: false });
const ThemeToggle = dynamic(() => import('@/components/ui/ThemeToggle').then(m => ({ default: m.ThemeToggle })), { ssr: false });

export default function Dashboard() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between mb-6 animate-fade-in">
        <div>
          <h1 className="font-display text-4xl font-bold text-text-primary tracking-tight bg-gradient-to-r from-accent-blue via-accent-purple to-accent-cyan bg-clip-text text-transparent">
            Dashboard
          </h1>
          <p className="text-text-secondary text-xs font-mono capitalize mt-2">{dateStr}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-mono text-text-secondary bg-bg-card border border-border rounded-lg px-3 py-2 backdrop-blur-sm hover:border-accent-blue transition-colors duration-300">
            <Activity size={12} className="text-accent-green live-dot" />
            Temps réel · {timeStr}
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* Grid principal */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* Ligne 1 : Météo + Crypto */}
        <WeatherWidget />
        <CryptoWidget />

        {/* Énergie */}
        <EnergyWidget />

        {/* Football — prend 2 colonnes sur grand écran */}
        <div className="md:col-span-2 xl:col-span-2">
          <FootballWidget />
        </div>

        {/* Actualités — colonne entière */}
        <div className="md:col-span-2 xl:col-span-3">
          <NewsWidget />
        </div>
      </div>

      <footer className="mt-8 text-center text-xs text-text-muted font-mono">
        Données mises à jour automatiquement · Météo 10min · Crypto 30s · Énergie 5min · Football 30s · Actus 15min
      </footer>
    </main>
  );
}
