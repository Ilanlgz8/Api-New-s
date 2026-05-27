import { NextResponse } from 'next/server';
import { runImmediateResultsPrefetch } from '../route';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    // Optional simple auth: allow only local requests or require a secret header
    const secret = process.env.ADMIN_REFRESH_SECRET;
    if (secret) {
      const hdr = request.headers.get('x-admin-secret');
      if (!hdr || hdr !== secret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const result = await runImmediateResultsPrefetch();
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
