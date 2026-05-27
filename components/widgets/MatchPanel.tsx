'use client';

import React, { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { X } from 'lucide-react';
import type { FootballEvent } from '@/lib/footballTypes';

const BEBAS: React.CSSProperties = { fontFamily: "'Bebas Neue', monospace" };

interface MatchPanelProps {
  match: FootballEvent;
  onClose: () => void;
}

export function MatchPanel({ match, onClose }: MatchPanelProps) {
  const [tab, setTab] = useState<'apercu' | 'compos' | 'forme' | 'classement'>('apercu');
  const { data, isLoading } = useSWR(
    match ? `/api/football/match?id=${match.id}` : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 120000, revalidateIfStale: false }
  );

  const m = useMemo(() => ({ ...(match ?? {}), ...(data?.match ?? {}) }), [data?.match, match]);
  const pre = data?.preMatch ?? null;
  const stats = data?.stats ?? null;
  const statsSource = data?.preMatch?.source ?? 'football-data';
  const odds = m?.publicOdds ?? match?.publicOdds ?? null;

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const homeScore = m?.score?.fullTime?.home ?? m?.score?.halfTime?.home ?? null;
  const awayScore = m?.score?.fullTime?.away ?? m?.score?.halfTime?.away ?? null;
  const htHome    = m.score?.halfTime?.home;
  const htAway    = m.score?.halfTime?.away;
  const isLive    = m.status === 'IN_PLAY' || m.status === 'PAUSED';
  const isFinished = ['FINISHED', 'FT', 'AET', 'PEN'].includes(m.status);
  const isPreMatch = !isLive && !isFinished;
  const liveMinute = m?.liveDetails?.minute ?? m?.minute;
  const kickoffLabel = m?.utcDate ? formatKickoff(m.utcDate) : null;
  const venueLabel = m?.venue ?? null;

  const homeGoals = m.goals?.filter((g: any) => g.team?.id === m.homeTeam?.id) ?? [];
  const awayGoals = m.goals?.filter((g: any) => g.team?.id === m.awayTeam?.id) ?? [];

  const homeForm = pre?.form?.home ?? [];
  const awayForm = pre?.form?.away ?? [];
  const standings = pre?.standings?.table ?? [];

  const formSummary = useMemo(() => {
    const summarize = (list: any[]) => {
      if (!Array.isArray(list) || list.length === 0) return null;
      return {
        W: list.filter((x: any) => x.outcome === 'W').length,
        D: list.filter((x: any) => x.outcome === 'D').length,
        L: list.filter((x: any) => x.outcome === 'L').length,
      };
    };
    return {
      home: summarize(homeForm),
      away: summarize(awayForm),
    };
  }, [homeForm, awayForm]);

  const standingHome = useMemo(
    () => standings.find((row: any) => sameTeam(row, m.homeTeam)),
    [m.homeTeam, standings]
  );
  const standingAway = useMemo(
    () => standings.find((row: any) => sameTeam(row, m.awayTeam)),
    [m.awayTeam, standings]
  );

  const hasHomeForm = homeForm.length > 0;
  const hasAwayForm = awayForm.length > 0;
  const hasH2H = Boolean(pre?.h2h) &&
    Number((pre?.h2h?.homeWins ?? 0) + (pre?.h2h?.awayWins ?? 0) + (pre?.h2h?.draw ?? 0)) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-2 md:items-center md:p-4"
      style={{
        background:
          'radial-gradient(circle at top, rgba(255,42,42,.18), transparent 34%), radial-gradient(circle at bottom right, rgba(96,165,250,.12), transparent 28%), rgba(5,5,5,.84)',
        backdropFilter: 'blur(10px)',
      }}
      onClick={onClose}>
      <div className="relative w-full max-w-6xl overflow-hidden rounded-[32px] shadow-[0_40px_120px_rgba(0,0,0,.65)]"
        style={{
          background: 'linear-gradient(180deg, rgba(20,20,20,.98), rgba(10,10,10,.98))',
          border: '1px solid rgba(255,255,255,.08)',
          boxShadow: '0 0 0 1px rgba(255,42,42,.15), 0 40px 120px rgba(0,0,0,.65)',
          maxHeight: '94vh',
          overflowY: 'auto',
        }}
        onClick={e => e.stopPropagation()}>

        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,42,42,.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(34,211,238,.08),transparent_24%)]" />

        {/* Header */}
        <div className="relative z-10 flex items-center justify-between border-b border-white/8 px-4 py-3 md:px-5"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,0))' }}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5 shadow-[0_10px_30px_rgba(0,0,0,.25)]">
              {m.competition?.emblem ? (
                <img src={m.competition.emblem} alt="" className="h-6 w-6 object-contain" />
              ) : (
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-zinc-500">FC</span>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-black uppercase tracking-[0.32em] text-zinc-500">{m.competition?.name ?? 'Competition'}</div>
              <div className="mt-1 text-xs text-zinc-400">{isPreMatch ? 'Analyse avant match' : isLive ? 'En direct' : 'Compte rendu du match'}</div>
            </div>
          </div>
          <button onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:border-[#ff2a2a]/60 hover:bg-[#ff2a2a]/10 hover:text-white">
            <X size={16} />
          </button>
        </div>

        {/* Score principal */}
        <div className="relative z-10 px-4 py-4 md:px-6 md:py-6">
          <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015))] p-4 md:p-5">
            <div className="grid items-center gap-4 md:gap-6" style={{ gridTemplateColumns: '1fr minmax(220px,auto) 1fr' }}>
            {/* Domicile */}
            <div className="flex flex-col items-center gap-2 md:gap-3">
              {m.homeTeam?.crest && (
                <img src={m.homeTeam.crest} alt="" className="h-14 w-14 object-contain drop-shadow-[0_10px_20px_rgba(0,0,0,.3)] md:h-16 md:w-16"
                  onError={e => (e.currentTarget.style.display = 'none')} />
              )}
              <span className="max-w-[120px] text-center text-sm font-bold leading-tight text-white md:max-w-[180px] md:text-base">
                {m.homeTeam?.name}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[9px] font-black uppercase tracking-[0.28em] text-zinc-400">Domicile</span>
            </div>

            {/* Score */}
            <div className="flex min-w-0 flex-col items-center gap-2">
              {isLive && (
                <div className="inline-flex items-center gap-1.5 rounded-full border border-[#ff2a2a]/25 bg-[#ff2a2a]/10 px-3 py-1">
                  <span className="h-2 w-2 rounded-full bg-[#ff2a2a] live-dot" />
                  <span className="text-[10px] font-black uppercase tracking-[0.28em] text-[#ffb3b3] font-mono">
                    {liveMinute ? `${liveMinute}'` : 'LIVE'}
                  </span>
                </div>
              )}
              <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,42,42,.12),rgba(10,10,10,.92))] px-6 py-4 text-center shadow-[0_10px_30px_rgba(0,0,0,.28)]">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,.08),transparent_40%)]" />
                <div className="relative flex items-center gap-1.5">
                  {[homeScore, awayScore].map((s, i) => (
                    <React.Fragment key={i}>
                      {i === 1 && (
                        <span style={{ ...BEBAS, fontSize: '26px', color: '#7b7b7b', WebkitTextFillColor: '#7b7b7b' }}> – </span>
                      )}
                      <span style={{
                        ...BEBAS,
                        fontSize: '54px',
                        lineHeight: 1,
                        background: 'linear-gradient(180deg,#fff,#cfcfcf)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                      }}>{s ?? '–'}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 text-[10px] font-black uppercase tracking-[0.26em] text-zinc-400">
                {htHome !== null && <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">MT {htHome}–{htAway}</span>}
                {!isLive && kickoffLabel && <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">{kickoffLabel}</span>}
              </div>
            </div>

            {/* Extérieur */}
            <div className="flex flex-col items-center gap-2 md:gap-3">
              {m.awayTeam?.crest && (
                <img src={m.awayTeam.crest} alt="" className="h-14 w-14 object-contain drop-shadow-[0_10px_20px_rgba(0,0,0,.3)] md:h-16 md:w-16"
                  onError={e => (e.currentTarget.style.display = 'none')} />
              )}
              <span className="max-w-[120px] text-center text-sm font-bold leading-tight text-white md:max-w-[180px] md:text-base">
                {m.awayTeam?.name}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[9px] font-black uppercase tracking-[0.28em] text-zinc-400">Extérieur</span>
            </div>
          </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 rounded-full border-2 border-border border-t-blue-500 animate-spin" />
            </div>
          ) : (
            <div className="relative z-10 px-4 pb-6 pt-2 space-y-5 md:px-6">
              <div className="grid grid-cols-4 gap-2 rounded-full border border-white/10 bg-white/5 p-1 md:max-w-2xl">
                <TabButton active={tab === 'apercu'} onClick={() => setTab('apercu')} label="Apercu" />
                <TabButton active={tab === 'compos'} onClick={() => setTab('compos')} label="Compos" />
                <TabButton active={tab === 'forme'} onClick={() => setTab('forme')} label="Forme" />
                <TabButton active={tab === 'classement'} onClick={() => setTab('classement')} label="Classement" />
              </div>

              {tab === 'apercu' && (
                <>
                  {isPreMatch ? (
                    <Section title="Avant-match">
                      <div className="space-y-3">
                        <div className="grid gap-2 md:grid-cols-3">
                          <MetaCard
                            label="Coup d'envoi"
                            value={kickoffLabel ?? 'A venir'}
                            hint={venueLabel ?? m.competition?.name ?? 'Match'}
                          />
                          <MetaCard
                            label="Classement"
                            value={`${standingHome?.position ?? '—'} / ${standingAway?.position ?? '—'}`}
                            hint="Domicile / Extérieur"
                          />
                          <OddsCard odds={odds} />
                        </div>

                        <div className="grid gap-2 md:grid-cols-2">
                          <TeamFormCard
                            team={m.homeTeam}
                            summary={formSummary.home}
                            form={homeForm}
                            standing={standingHome}
                            hasData={hasHomeForm}
                            alignment="left"
                          />
                          <TeamFormCard
                            team={m.awayTeam}
                            summary={formSummary.away}
                            form={awayForm}
                            standing={standingAway}
                            hasData={hasAwayForm}
                            alignment="right"
                          />
                        </div>
                      </div>
                    </Section>
                  ) : stats && stats.length >= 2 && hasRealStats(stats) ? (
                    <Section title="Stats du match">
                      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                        <StatCard label="Possession" home={statValue(stats, 0, 'Ball Possession')} away={statValue(stats, 1, 'Ball Possession')} />
                        <StatCard label="Tirs" home={statValue(stats, 0, 'Total Shots')} away={statValue(stats, 1, 'Total Shots')} />
                        <StatCard label="Tirs cadrés" home={statValue(stats, 0, 'Shots on Goal')} away={statValue(stats, 1, 'Shots on Goal')} />
                        <StatCard label="Corners" home={statValue(stats, 0, 'Corner Kicks')} away={statValue(stats, 1, 'Corner Kicks')} />
                      </div>
                      <div className="mt-2 grid gap-2 md:grid-cols-3">
                        <StatRow label="Fautes" home={statValue(stats, 0, 'Fouls')} away={statValue(stats, 1, 'Fouls')} />
                        <StatRow label="Jaunes" home={statValue(stats, 0, 'Yellow Cards')} away={statValue(stats, 1, 'Yellow Cards')} />
                        <StatRow label="Rouges" home={statValue(stats, 0, 'Red Cards')} away={statValue(stats, 1, 'Red Cards')} />
                      </div>
                    </Section>
                  ) : (
                    <Section title="Stats du match">
                      <div className="rounded-lg border border-dashed border-white/10 bg-white/5 px-3 py-3 text-[11px] text-zinc-300">
                        Les stats détaillées n'ont pas encore été récupérées pour cette rencontre.
                        <span className="ml-1 text-zinc-400">Source: {statsSource}</span>
                      </div>
                    </Section>
                  )}

                  {isPreMatch && (
                    <Section title="Confrontations directes">
                      <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr] md:items-center">
                        <H2HCard team={m.homeTeam} wins={pre?.h2h?.homeWins} hasData={hasH2H} alignment="left" />
                        <div className="flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                          <div className="text-center">
                            <div className="text-[10px] font-black uppercase tracking-[0.3em] text-zinc-500">H2H</div>
                            <div className="mt-1 text-xl font-black text-white">
                              {displayMetric(pre?.h2h?.homeWins, hasH2H)} - {displayMetric(pre?.h2h?.draw, hasH2H)} - {displayMetric(pre?.h2h?.awayWins, hasH2H)}
                            </div>
                            <div className="text-[10px] text-zinc-400">{hasH2H ? 'victoires / nuls / défaites' : 'Aucune confrontation récente'}</div>
                          </div>
                        </div>
                        <H2HCard team={m.awayTeam} wins={pre?.h2h?.awayWins} hasData={hasH2H} alignment="right" />
                      </div>
                    </Section>
                  )}
                </>
              )}

              {tab === 'compos' && (
                <Section title={isPreMatch ? 'Compositions probables' : 'Compositions officielles / probables'}>
                  <div className="mb-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-zinc-300">
                    {isPreMatch
                      ? 'Avant match, les compositions sont estimees a partir des derniers XI connus.'
                      : 'Pendant et apres match, les compositions deviennent officielles quand la source les publie.'}
                  </div>
                  <LineupPitch
                    homeTeam={m.homeTeam}
                    awayTeam={m.awayTeam}
                    homeLineup={pre?.lineups?.home}
                    awayLineup={pre?.lineups?.away}
                  />
                </Section>
              )}

              {tab === 'forme' && (
                <Section title="Forme recente (10 derniers)">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <FormCard team={m.homeTeam} summary={formSummary.home} form={homeForm} />
                    <FormCard team={m.awayTeam} summary={formSummary.away} form={awayForm} />
                  </div>
                </Section>
              )}

              {tab === 'classement' && (
                <Section title={pre?.standings?.competition ? `Classement ${pre.standings.competition}` : 'Classement'}>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="max-h-72 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-[#08111f] text-text-muted">
                          <tr>
                            <th className="px-2 py-2 text-left">#</th>
                            <th className="px-2 py-2 text-left">Equipe</th>
                            <th className="px-2 py-2 text-right">Pts</th>
                            <th className="px-2 py-2 text-right">J</th>
                            <th className="px-2 py-2 text-right">G</th>
                            <th className="px-2 py-2 text-right">N</th>
                            <th className="px-2 py-2 text-right">P</th>
                          </tr>
                        </thead>
                        <tbody>
                          {standings.map((row: any) => (
                            <tr key={row.position} className="border-t border-border/60">
                              <td className="px-2 py-1.5">
                                <span className={`inline-block h-2 w-2 mr-1 ${zoneDotClass(row.zone)}`} />
                                {row.position}
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                  {row.crest ? <img src={row.crest} alt="" className="h-4 w-4 object-contain" /> : null}
                                  <span className="truncate">{row.shortName ?? row.teamName}</span>
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-right font-black text-white">{row.points}</td>
                              <td className="px-2 py-1.5 text-right">{row.playedGames}</td>
                              <td className="px-2 py-1.5 text-right">{row.won}</td>
                              <td className="px-2 py-1.5 text-right">{row.draw}</td>
                              <td className="px-2 py-1.5 text-right">{row.lost}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[10px] uppercase tracking-wider text-text-muted">
                    <Legend color="bg-emerald-400" label="LDC" />
                    <Legend color="bg-blue-400" label="Europa" />
                    <Legend color="bg-cyan-400" label="Conference" />
                    <Legend color="bg-orange-400" label="Barrage" />
                    <Legend color="bg-red-500" label="Relegation" />
                  </div>
                </Section>
              )}

              {(homeGoals.length > 0 || awayGoals.length > 0) && (
                <Section title="Buteurs">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      {homeGoals.map((g: any, i: number) => (
                        <GoalRow key={i} goal={g} side="home" />
                      ))}
                    </div>
                    <div className="space-y-1">
                      {awayGoals.map((g: any, i: number) => (
                        <GoalRow key={i} goal={g} side="away" />
                      ))}
                    </div>
                  </div>
                </Section>
              )}

              <Section title="Infos match">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {m.venue && <Info label="Stade" value={m.venue} />}
                  {m.referees?.[0] && <Info label="Arbitre" value={m.referees[0].name} />}
                  {m.matchday && <Info label="Journée" value={`J${m.matchday}`} />}
                  {m.stage && <Info label="Phase" value={m.stage.replace(/_/g, ' ')} />}
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2 py-1.5 text-[11px] font-black uppercase tracking-wider transition-colors ${
        active
          ? 'border-[#ff2a2a] bg-[#ff2a2a]/20 text-white shadow-[0_0_16px_rgba(255,42,42,.18)]'
          : 'border-white/10 bg-white/5 text-zinc-400 hover:border-[#ff2a2a]/40 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function zoneDotClass(zone: string) {
  if (zone === 'champions') return 'bg-emerald-400';
  if (zone === 'europa') return 'bg-blue-400';
  if (zone === 'conference') return 'bg-cyan-400';
  if (zone === 'playoff') return 'bg-orange-400';
  if (zone === 'relegation') return 'bg-red-500';
  return 'bg-zinc-500';
}

function LineupPitch({ homeTeam, awayTeam, homeLineup, awayLineup }: any) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <PitchTeamCard team={homeTeam} lineup={homeLineup} mirror={false} />
      <PitchTeamCard team={awayTeam} lineup={awayLineup} mirror />
    </div>
  );
}

function PitchTeamCard({ team, lineup, mirror }: { team: any; lineup: any; mirror?: boolean }) {
  const starters = lineup?.starters ?? [];
  const formation = lineup?.formation ?? '4-3-3';
  const rows = buildFormationRows(starters, formation);
  const hasData = starters.length > 0;

  return (
    <div className="rounded-xl border border-[#ff2a2a]/15 bg-[#232323] p-3">
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-400">
        <span>{team?.shortName ?? team?.name}</span>
        <span className={lineup?.official ? 'text-emerald-300' : 'text-amber-300'}>
          {lineup?.official ? 'Officiel' : 'Estimee'} {lineup?.formation ? `(${lineup.formation})` : `(${formation})`}
        </span>
      </div>

      <div className="relative overflow-hidden rounded-lg border border-[#ff2a2a]/15 bg-[linear-gradient(180deg,#202020,#151515)] p-2">
        <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0,transparent_49.5%,rgba(255,255,255,.12)_49.5%,rgba(255,255,255,.12)_50.5%,transparent_50.5%,transparent_100%)]" />
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/10" />
        <div className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
        <div className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10" />

        <div className="relative min-h-[240px] rounded-md border border-[#3a3a3a] bg-[linear-gradient(180deg,#0d5d2d,#0a4f26)] p-2 md:min-h-[290px]">
          <div className="absolute inset-x-3 top-3 h-[calc(100%-1.5rem)] rounded-md border border-white/10" />
          <div className="absolute left-1/2 top-3 h-[calc(100%-1.5rem)] w-px bg-white/10" />
          <div className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10" />

          <div className="relative flex h-full flex-col justify-between py-2 md:py-3">
            {rows.map((row, rowIdx) => (
              <div key={`${team?.name}-${rowIdx}`} className={`flex items-center justify-center gap-1.5 md:gap-2 ${mirror ? 'flex-row-reverse' : ''}`}>
                {row.map((player: any, idx: number) => (
                  <div key={`${player.id ?? player.name}-${idx}`} className="flex min-w-[34px] flex-col items-center gap-0.5 text-center">
                    <div className="inline-flex h-8 w-8 items-center justify-center rounded-sm border border-white/10 bg-[#ff2a2a] text-[10px] font-black text-white shadow-[0_4px_12px_rgba(0,0,0,.22)] md:h-9 md:w-9 md:text-[11px]">
                      {player.shirtNumber ?? '—'}
                    </div>
                    <span className="max-w-[64px] truncate text-[8px] font-semibold leading-none text-white/95 md:max-w-[72px] md:text-[9px]">
                      {player.name}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {!hasData ? (
          <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2 text-center text-[11px] text-zinc-300">
            Compo non disponible pour cette source.
          </div>
        ) : null}
      </div>

      {lineup?.bench?.length ? (
        <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2">
          <div className="mb-1 text-[9px] font-black uppercase tracking-wider text-zinc-400">Remplaçants</div>
          <div className="flex flex-wrap gap-1.5">
            {lineup.bench.slice(0, 7).map((player: any, idx: number) => (
              <span key={`${player.id ?? player.name}-bench-${idx}`} className="inline-flex items-center gap-1 rounded-sm border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white">
                <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-sm bg-white/10 px-0.5 font-black">{player.shirtNumber ?? '—'}</span>
                <span className="max-w-[90px] truncate">{player.name}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildFormationRows(starters: any[], formation: string) {
  const list = Array.isArray(starters) ? starters.slice(0, 11) : [];
  if (!list.length) return [];

  const formationCounts = formation
    .split('-')
    .map((part) => Number(part))
    .filter((num) => Number.isFinite(num) && num > 0);

  const counts = formationCounts.length >= 3 ? [1, ...formationCounts] : [1, 4, 3, 3];
  const totalExpected = counts.reduce((sum, value) => sum + value, 0);
  const sorted = [...list].sort((a, b) => {
    const groupOrder = (player: any) => {
      const value = `${player.position ?? ''} ${player.name ?? ''}`.toLowerCase();
      if (value.includes('goalkeeper') || value.includes('gk')) return 0;
      if (value.includes('defender') || value.includes('back') || value.includes('centre back') || value.includes('full back')) return 1;
      if (value.includes('midfielder') || value.includes('midfield') || value.includes('winger')) return 2;
      if (value.includes('forward') || value.includes('attacker') || value.includes('striker') || value.includes('center forward')) return 3;
      return 2;
    };
    const ga = groupOrder(a);
    const gb = groupOrder(b);
    if (ga !== gb) return ga - gb;
    return Number(String(a.shirtNumber ?? a.name ?? '').replace(/\D/g, '')) - Number(String(b.shirtNumber ?? b.name ?? '').replace(/\D/g, ''));
  });

  const normalized = sorted.length === totalExpected ? sorted : [...sorted, ...Array.from({ length: Math.max(0, totalExpected - sorted.length) }, (_, idx) => ({
    id: `placeholder-${idx}`,
    name: '—',
    shirtNumber: '—',
  }))].slice(0, totalExpected);

  const rows: any[][] = [];
  let cursor = 0;
  for (const count of counts) {
    rows.push(normalized.slice(cursor, cursor + count));
    cursor += count;
  }
  return rows;
}

function FormCard({ team, summary, form }: { team: any; summary: any; form: any[] }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="mb-2 text-sm font-black text-white">{team?.name}</p>
      <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider">
        <span className="text-emerald-400">V {summary.W}</span>
        <span className="text-amber-400">N {summary.D}</span>
        <span className="text-red-400">D {summary.L}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {form.slice(0, 10).map((f: any) => (
          <span
            key={f.id}
            title={`${f.outcome} - ${f.opponent}`}
            className={`inline-flex h-4.5 w-4.5 rounded-full border ${formDotClass(f.outcome)}`}
          />
        ))}
      </div>
      <div className="space-y-1">
        {form.slice(0, 5).map((f: any) => (
          <div key={`${f.id}-row`} className="flex items-center justify-between text-[11px]">
            <span className="truncate text-zinc-300">vs {f.opponent}</span>
            <span className="font-mono text-zinc-400">{f.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formBadgeClass(outcome: string) {
  if (outcome === 'W') return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50';
  if (outcome === 'D') return 'bg-amber-500/20 text-amber-300 border border-amber-500/50';
  return 'bg-red-500/20 text-red-300 border border-red-500/50';
}

function formDotClass(outcome: string) {
  if (outcome === 'W') return 'border-emerald-400/70 bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.25)]';
  if (outcome === 'D') return 'border-amber-400/70 bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,.22)]';
  return 'border-red-400/70 bg-red-400 shadow-[0_0_10px_rgba(248,113,113,.22)]';
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 ${color}`} />
      {label}
    </span>
  );
}

function MetaCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="text-[10px] font-black uppercase tracking-[0.28em] text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-black text-white">{value}</div>
      <div className="mt-1 text-[10px] text-zinc-400">{hint}</div>
    </div>
  );
}

function OddsCard({ odds }: { odds: any }) {
  if (!odds) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
        <div className="text-[10px] font-black uppercase tracking-[0.28em] text-zinc-500">Cotes</div>
        <div className="mt-1 text-lg font-black text-white">—</div>
        <div className="mt-1 text-[10px] text-zinc-400">Non dispo</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-black uppercase tracking-[0.28em] text-zinc-500">Cotes</div>
        <div className="text-[9px] uppercase tracking-[0.26em] text-emerald-300">{odds.source === 'public' ? odds.bookmaker ?? 'Marché' : 'Modèle'}</div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <OddPill label="1" value={odds.win} accent="from-emerald-500/30 to-emerald-500/10" />
        <OddPill label="N" value={odds.draw} accent="from-amber-500/30 to-amber-500/10" />
        <OddPill label="2" value={odds.loss} accent="from-red-500/30 to-red-500/10" />
      </div>
      <div className="mt-1 text-[10px] text-zinc-400">{odds.lastUpdate ? `Maj ${new Date(odds.lastUpdate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'Cotes 1N2'}</div>
    </div>
  );
}

function OddPill({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-gradient-to-b ${accent} px-2 py-2`}>
      <div className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-300">{label}</div>
      <div className="mt-1 text-lg font-black text-white">{formatOdd(value)}</div>
    </div>
  );
}

function TeamFormCard({ team, summary, form, standing, hasData, alignment }: { team: any; summary: any; form: any[]; standing: any; hasData: boolean; alignment: 'left' | 'right' }) {
  const isRight = alignment === 'right';
  return (
    <div className="rounded-2xl border border-white/10 bg-[#171717] p-3">
      <div className={`flex items-start justify-between gap-2 ${isRight ? 'text-right' : ''}`}>
        <div className={isRight ? 'order-2' : ''}>
          <div className="text-[10px] font-black uppercase tracking-[0.28em] text-zinc-500">Forme</div>
          <div className="mt-1 text-base font-black text-white">{team?.shortName ?? team?.name ?? 'Equipe'}</div>
          <div className="mt-0.5 text-[10px] text-zinc-400">{standing?.position ? `#${standing.position}` : 'Pas de rang'}</div>
        </div>
        <div className={`rounded-full border border-white/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.25em] text-zinc-300 ${isRight ? 'order-1' : ''}`}>
          {summary ? `${summary.W}V ${summary.D}N ${summary.L}D` : 'Non dispo'}
        </div>
      </div>
      {hasData ? (
        <div className={`mt-3 flex gap-1.5 ${isRight ? 'justify-end flex-row-reverse' : ''}`}>
          {form.slice(0, 5).map((item: any) => (
            <span
              key={item.id}
              title={`${item.outcome} - ${item.opponent}`}
              className={`inline-flex h-3.5 w-3.5 rounded-full border ${formDotClass(item.outcome)}`}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-white/10 bg-white/5 px-2 py-2 text-[11px] text-zinc-400">
          Forme indisponible sur cette source.
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-zinc-400">
        <div className={`rounded-xl border border-white/10 bg-white/5 px-2 py-2 ${isRight ? 'text-right' : ''}`}>
          <div className="uppercase tracking-[0.25em] text-zinc-500">Dernier</div>
          <div className="mt-1 text-white">{form[0]?.score ?? '—'}</div>
        </div>
        <div className={`rounded-xl border border-white/10 bg-white/5 px-2 py-2 ${isRight ? 'text-right' : ''}`}>
          <div className="uppercase tracking-[0.25em] text-zinc-500">Adversaire</div>
          <div className="mt-1 truncate text-white">{form[0]?.opponent ?? '—'}</div>
        </div>
      </div>
    </div>
  );
}

function H2HCard({ team, wins, hasData, alignment }: { team: any; wins: number | undefined; hasData: boolean; alignment: 'left' | 'right' }) {
  const isRight = alignment === 'right';
  return (
    <div className={`rounded-xl border border-white/10 bg-white/5 px-3 py-3 ${isRight ? 'text-right' : ''}`}>
      <div className="text-[10px] font-black uppercase tracking-[0.28em] text-zinc-500">{team?.shortName ?? team?.name ?? 'Equipe'}</div>
      <div className="mt-1 text-2xl font-black text-white">{displayMetric(wins, hasData)}</div>
      <div className="text-[10px] text-zinc-400">victoires directes</div>
    </div>
  );
}

function displayMetric(value: number | null | undefined, hasData = true) {
  if (!hasData) return '—';
  return Number.isFinite(Number(value)) ? String(value) : '—';
}

function formatKickoff(dateStr: string) {
  return new Date(dateStr).toLocaleString('fr-FR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
}

function formatOdd(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-black text-text-muted uppercase tracking-widest font-mono">{title}</span>
        <div className="flex-1 h-px" style={{ background: 'linear-gradient(90deg,#0a1520,transparent)' }} />
      </div>
      {children}
    </div>
  );
}

function GoalRow({ goal, side }: { goal: any; side: 'home' | 'away' }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs ${side === 'away' ? 'flex-row-reverse' : ''}`}>
      <span className="text-yellow-500 text-xs">⚽</span>
      <span className="text-text-primary font-semibold truncate">{goal.scorer?.name?.split(' ').pop()}</span>
      <span className="text-text-muted font-mono">{goal.minute?.regular}'</span>
    </div>
  );
}

function normalizeName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|as|ac|de|the|club|sporting)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function sameTeam(row: any, team: any) {
  const rowKey = normalizeName(`${row?.teamName ?? row?.shortName ?? ''}`);
  const teamKey = normalizeName(`${team?.name ?? team?.shortName ?? ''}`);
  return rowKey === teamKey || rowKey.includes(teamKey) || teamKey.includes(rowKey);
}

function statValue(stats: any[], idx: number, type: string) {
  return stats?.[idx]?.statistics?.find((s: any) => s.type === type)?.value ?? '-';
}

function hasRealStats(stats: any[]) {
  return [
    'Ball Possession',
    'Total Shots',
    'Shots on Goal',
    'Fouls',
    'Corner Kicks',
    'Yellow Cards',
    'Red Cards',
  ].some((type) => stats?.some((team: any) => team?.statistics?.some((s: any) => s.type === type && s.value != null)));
}

function StatCard({ label, home, away }: { label: string; home: any; away: any }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
      <div className="text-[10px] font-black uppercase tracking-[0.28em] text-zinc-500">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="text-2xl font-black text-white">{home}</div>
        <div className="text-2xl font-black text-[#ffb3b3]">{away}</div>
      </div>
    </div>
  );
}

function StatRow({ label, home, away }: { label: string; home: any; away: any }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_56px] items-center gap-2 text-xs">
      <span className="text-left font-mono font-black text-white">{home}</span>
      <span className="text-center uppercase tracking-wider text-zinc-400">{label}</span>
      <span className="text-right font-mono font-black text-white">{away}</span>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg rounded-lg p-2 border border-border">
      <div className="text-[9px] text-text-muted uppercase tracking-wider font-mono mb-0.5">{label}</div>
      <div className="text-xs text-text-primary font-semibold truncate">{value}</div>
    </div>
  );
}