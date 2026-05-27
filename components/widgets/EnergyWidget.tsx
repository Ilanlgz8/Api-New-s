'use client';

import React from 'react';
import { Zap } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { useEnergy } from '@/hooks/useEnergy';
import { Card, CardHeader } from '@/components/ui/Card';
import { WidgetSkeleton, ErrorCard } from '@/components/ui/Skeleton';
import type { EnergySource } from '@/lib/energyTypes';

const ENERGY_COLORS: Record<string, string> = {
  NUCLEAR: '#8b5cf6',
  WIND: '#22c55e',
  SOLAR: '#f59e0b',
  HYDRO: '#3b82f6',
  THERMAL: '#ef4444',
  BIOENERGY: '#10b981',
  OTHER: '#64748b',
};

const ENERGY_LABELS: Record<string, string> = {
  NUCLEAR: 'Nucléaire',
  WIND: 'Éolien',
  SOLAR: 'Solaire',
  HYDRO: 'Hydraulique',
  THERMAL: 'Thermique',
  BIOENERGY: 'Bioénergie',
};

export const EnergyWidget = React.memo(function EnergyWidget() {
  const { data, error, isLoading } = useEnergy();

  if (isLoading) return <WidgetSkeleton />;
  if (error) return <ErrorCard message="Données énergie indisponibles" />;

  // Parse les données RTE
  const productions: Array<EnergySource & { name: string }> = [];
  let totalProduction = 0;
  let consumption = 0;

  if (data?.production) {
    for (const prod of data.production) {
      productions.push({
        ...prod,
        name: ENERGY_LABELS[prod.key] ?? prod.label,
      });
      totalProduction += prod.value;
    }
  }

  consumption = data?.consumption ?? 0;

  const balance = totalProduction - consumption;

  return (
    <Card accent="green">
      <CardHeader title="Énergie France" icon={<Zap size={14} />} />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-5">
        <div className="bg-gradient-to-br from-green-500/10 to-transparent border border-green-500/20 rounded-lg p-3 hover:border-green-500/40 transition-colors">
          <div className="text-xs font-mono uppercase tracking-widest text-green-300/60 mb-1.5">Production</div>
          <div className="font-display text-xl font-bold text-green-300">
            {(totalProduction / 1000).toFixed(1)}
          </div>
          <div className="text-xs text-text-secondary/60 font-mono">GW</div>
        </div>
        <div className="bg-gradient-to-br from-blue-500/10 to-transparent border border-blue-500/20 rounded-lg p-3 hover:border-blue-500/40 transition-colors">
          <div className="text-xs font-mono uppercase tracking-widest text-blue-300/60 mb-1.5">Consommation</div>
          <div className="font-display text-xl font-bold text-blue-300">
            {(consumption / 1000).toFixed(1)}
          </div>
          <div className="text-xs text-text-secondary/60 font-mono">GW</div>
        </div>
        <div className={`bg-gradient-to-br ${balance >= 0 ? 'from-green-500/10' : 'from-red-500/10'} to-transparent border ${balance >= 0 ? 'border-green-500/20 hover:border-green-500/40' : 'border-red-500/20 hover:border-red-500/40'} rounded-lg p-3 transition-colors`}>
          <div className={`text-xs font-mono uppercase tracking-widest ${balance >= 0 ? 'text-green-300/60' : 'text-red-300/60'} mb-1.5`}>Balance</div>
          <div className={`font-display text-xl font-bold ${balance >= 0 ? 'text-green-300' : 'text-red-300'}`}>
            {balance >= 0 ? '+' : ''}{(balance / 1000).toFixed(1)}
          </div>
          <div className="text-xs text-text-secondary/60 font-mono">GW</div>
        </div>
      </div>

      {/* Chart */}
      {productions.length > 0 && (
        <div className="space-y-4">
          <div className="flex gap-4 items-center justify-between p-4 bg-gradient-to-br from-green-500/5 via-cyan-500/5 to-transparent rounded-xl border border-green-500/10">
            <div className="w-32 h-32 flex-shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie 
                    data={productions} 
                    dataKey="value" 
                    cx="50%" 
                    cy="50%" 
                    innerRadius={32} 
                    outerRadius={58} 
                    strokeWidth={2}
                    stroke="#0a0e1a"
                  >
                    {productions.map((entry) => (
                      <Cell key={entry.key} fill={entry.color} opacity={0.85} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => [`${(value / 1000).toFixed(1)} GW`, '']}
                    contentStyle={{ background: '#0f1629', border: '1px solid #1e2d4a', borderRadius: '8px', fontSize: '12px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Legend */}
            <div className="flex-1 space-y-2">
              {[...productions].sort((a, b) => b.value - a.value).map((p) => (
                <div key={p.name} className="flex items-center gap-3 group cursor-pointer transition-opacity hover:opacity-80">
                  <div className="w-3 h-3 rounded-full flex-shrink-0 transition-transform group-hover:scale-125" style={{ background: p.color }} />
                  <span className="text-xs text-text-secondary flex-1">{p.name}</span>
                  <span className="font-mono font-semibold text-text-primary text-sm">
                    {((p.value / totalProduction) * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
});
