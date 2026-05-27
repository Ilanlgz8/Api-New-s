import { NextResponse } from 'next/server';
import { runTargetedCompetitionPrefetch } from '../../route';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const secret = process.env.ADMIN_REFRESH_SECRET;
    if (secret) {
      const hdr = request.headers.get('x-admin-secret');
      if (!hdr || hdr !== secret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const body = await request.json().catch(() => ({} as any));
    const code = (body.code || new URL(request.url).searchParams.get('code'))?.toString();
    const from = Number(body.from ?? new URL(request.url).searchParams.get('from') ?? -7);
    const to = Number(body.to ?? new URL(request.url).searchParams.get('to') ?? 0);
    if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });

    const debug = String(new URL(request.url).searchParams.get('debug') || (body.debug ?? '')).toLowerCase() === 'true';
    const result = await runTargetedCompetitionPrefetch(code, from, to, debug);
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
