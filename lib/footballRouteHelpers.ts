import type { FootballEvent } from './footballTypes';

export type CompetitionInfoMap = Record<string, { name: string; emblem?: string | null }>;

function normalizeName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|as|ac|de|the|club|sporting)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function detectCompetitionCodeFromText(text = ''): string | null {
  const key = normalizeName(String(text ?? ''));
  if (!key) return null;
  if (key.includes('europaleague') || key.includes('uefaeuropaleague') || key.includes('uel') || key.includes('europa')) return 'UEL';
  if (key.includes('conferenceleague') || key.includes('uefaeuropaconferenceleague') || key.includes('uecl') || key.includes('conference')) return 'UECL';
  if (key.includes('championsleague') || key.includes('liguedeschampions') || key.includes('ucl') || key.includes('champions')) return 'CL';
  return null;
}

export function sameDay(a?: string, b?: string) {
  if (!a || !b) return false;
  return a.slice(0, 10) === b.slice(0, 10);
}

export function normalizeEventCompetition(event: any, competitionInfo: CompetitionInfoMap) {
  if (!event) return event;
  const comp = (event.competition ?? {}) as any;
  const currentCode = String(comp.code ?? '').toUpperCase();

  const topCodes = new Set(['FL1', 'CL', 'PL', 'PD', 'SA', 'BL1', 'UEL', 'UECL']);
  if (topCodes.has(currentCode)) return event;

  const labelCandidates = [(event.competition as any)?.name, event.competitionName, event.leagueName, event.tournament?.name, event.tournament?.title, event.source, event.title]
    .filter(Boolean)
    .join(' ');
  const inferred = detectCompetitionCodeFromText(labelCandidates);

  if (inferred && inferred !== currentCode) {
    event.competition = {
      ...(event.competition ?? {}),
      code: inferred,
      name: competitionInfo[inferred]?.name ?? event.competition?.name ?? inferred,
    };
    event.competitionName = event.competition.name;
    event.leagueName = event.competition.name;
  }

  return event;
}
