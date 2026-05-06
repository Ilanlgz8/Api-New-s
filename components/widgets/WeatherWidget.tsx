'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Wind, Droplets, Thermometer, MapPin, Search } from 'lucide-react';
import { useWeather } from '@/hooks/useWeather';
import { Card, CardHeader } from '@/components/ui/Card';
import { WidgetSkeleton, ErrorCard } from '@/components/ui/Skeleton';

const WEATHER_ICONS: Record<string, string> = {
  Clear: '☀️', Clouds: '☁️', Rain: '🌧️', Drizzle: '🌦️',
  Thunderstorm: '⛈️', Snow: '❄️', Mist: '🌫️', Fog: '🌫️',
};

export const WeatherWidget = React.memo(function WeatherWidget() {
  const [city, setCity] = useState('Furiani');
  const [input, setInput] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // Charge la ville sauvegardée au montage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('weather_city');
      if (saved) setCity(saved);
    }
  }, []);

  // Sauvegarde la ville à chaque changement
  useEffect(() => {
    if (typeof window !== 'undefined' && city) {
      window.localStorage.setItem('weather_city', city);
    }
  }, [city]);

  const { data, error, isLoading } = useWeather(undefined, undefined, city);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      setCity(input.trim());
      setInput('');
      setShowSearch(false);
    }
  }, [input]);

  return (
    <Card accent="blue">
      <CardHeader title="Météo" icon={<MapPin size={14} />}>
        <div className="flex items-center gap-2">
          {showSearch ? (
            <form onSubmit={handleSearch} className="flex items-center gap-1">
              <input
                autoFocus
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Ville..."
                className="bg-bg-hover border border-border rounded-lg px-2 py-1 text-xs text-text-primary font-mono w-28 outline-none focus:border-accent-blue transition-colors"
              />
              <button type="submit" className="text-accent-blue hover:text-white transition-colors">
                <Search size={13} />
              </button>
              <button type="button" onClick={() => setShowSearch(false)} className="text-text-secondary hover:text-text-primary text-xs">
                ✕
              </button>
            </form>
          ) : (
            <button
              onClick={() => setShowSearch(true)}
              className="flex items-center gap-1 text-xs text-text-secondary hover:text-accent-blue transition-colors font-mono"
            >
              <Search size={12} />
              {city}
            </button>
          )}
        </div>
      </CardHeader>

      {isLoading ? (
        <WidgetSkeleton />
      ) : error ? (
        <ErrorCard message={`Ville introuvable : "${city}"`} />
      ) : !data ? null : (
        <WeatherContent data={data} />
      )}
    </Card>
  );
});

const WeatherContent = React.memo(function WeatherContent({ data }: { data: any }) {
  const { current, forecast } = data;
  const icon = WEATHER_ICONS[current.weather[0].main] ?? '🌡️';

  return (
    <div className="space-y-5">
      {/* Main weather display */}
      <div className="bg-gradient-to-br from-blue-500/10 via-cyan-500/5 to-transparent rounded-xl p-5 border border-blue-500/20 relative overflow-hidden group">
        {/* Background glow */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
          <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-blue-500/20 to-transparent rounded-full blur-3xl" />
        </div>

        <div className="relative z-10 flex items-start justify-between">
          <div>
            <div className="text-6xl mb-3">{icon}</div>
            <div className="text-4xl font-display font-bold text-text-primary mb-2 tracking-tight">
              {Math.round(current.main.temp)}°
            </div>
            <div className="text-blue-300/80 text-sm font-medium capitalize">
              {current.weather[0].description}
            </div>
          </div>
          <div className="text-right">
            <div className="text-blue-400/60 text-xs font-mono uppercase tracking-widest mb-2">Ressenti</div>
            <div className="text-3xl font-display font-bold text-blue-300">
              {Math.round(current.main.feels_like)}°
            </div>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-3">
        <Stat icon={<Wind size={16} />} label="Vent" value={`${Math.round(current.wind.speed * 3.6)}`} unit="km/h" color="from-cyan-500 to-blue-500" />
        <Stat icon={<Droplets size={16} />} label="Humidité" value={`${current.main.humidity}`} unit="%" color="from-blue-500 to-indigo-500" />
        <Stat icon={<Thermometer size={16} />} label="Pression" value={`${current.main.pressure}`} unit="mb" color="from-indigo-500 to-purple-500" />
      </div>

      {/* Hourly forecast */}
      {forecast && (
        <div>
          <div className="text-xs font-mono uppercase tracking-widest text-text-secondary/60 mb-3">Prévisions 6h</div>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {forecast.list.slice(0, 6).map((item: any, i: number) => (
              <div 
                key={i} 
                className="flex-shrink-0 bg-gradient-to-br from-bg-hover/60 to-bg-accent/30 border border-border/50 rounded-xl p-3 min-w-[56px] text-center hover:border-blue-500/50 transition-all duration-300 hover:shadow-lg hover:shadow-blue-500/10"
              >
                <div className="text-xs font-mono text-text-secondary/70 mb-2">{new Date(item.dt * 1000).getHours()}h</div>
                <div className="text-2xl mb-2">{WEATHER_ICONS[item.weather[0].main] ?? '🌡️'}</div>
                <div className="text-sm font-mono font-semibold text-text-primary">{Math.round(item.main.temp)}°</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

function Stat({ icon, label, value, unit, color }: { icon: React.ReactNode; label: string; value: string | number; unit: string; color: string }) {
  const colorMap: Record<string, { border: string; bg: string; icon: string; label: string; value: string; unit: string }> = {
    'from-cyan-500 to-blue-500': {
      border: 'border-cyan-500/40',
      bg: 'from-cyan-950/40 to-cyan-900/20',
      icon: 'text-cyan-400',
      label: 'text-cyan-300/80',
      value: 'text-cyan-100',
      unit: 'text-cyan-400/70'
    },
    'from-blue-500 to-indigo-500': {
      border: 'border-blue-500/40',
      bg: 'from-blue-950/40 to-blue-900/20',
      icon: 'text-blue-400',
      label: 'text-blue-300/80',
      value: 'text-blue-100',
      unit: 'text-blue-400/70'
    },
    'from-indigo-500 to-purple-500': {
      border: 'border-indigo-500/40',
      bg: 'from-indigo-950/40 to-indigo-900/20',
      icon: 'text-indigo-400',
      label: 'text-indigo-300/80',
      value: 'text-indigo-100',
      unit: 'text-indigo-400/70'
    }
  };
  
  const styles = colorMap[color] || colorMap['from-cyan-500 to-blue-500'];

  return (
    <div className={`relative bg-gradient-to-br ${color} rounded-xl p-4 border ${styles.border} transition-all duration-300 group overflow-hidden backdrop-blur-sm hover:shadow-lg hover:shadow-black/20`}>
      {/* Background gradient overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br ${color} opacity-5 group-hover:opacity-10 transition-opacity duration-300`} />
      
      {/* Top glow line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      
      <div className="relative z-10">
        <div className={`flex items-center gap-2 mb-3`}>
          <span className={`${styles.icon}`}>{icon}</span>
          <span className={`text-xs font-mono uppercase tracking-widest font-bold ${styles.label}`}>{label}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <div className={`text-2xl font-display font-bold ${styles.value}`}>{value}</div>
          <div className={`text-xs font-mono font-semibold ${styles.unit}`}>{unit}</div>
        </div>
      </div>
    </div>
  );
}