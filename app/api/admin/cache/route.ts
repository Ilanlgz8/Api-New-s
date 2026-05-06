import { NextResponse } from 'next/server';
import { deleteCacheEntry } from '@/lib/cache';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key missing' }, { status: 400 });

  const ok = deleteCacheEntry(key);
  return NextResponse.json({ key, deleted: ok });
}

export async function POST(request: Request) {
  // Accept JSON { key }
  try {
    const body = await request.json();
    const key = body?.key;
    if (!key) return NextResponse.json({ error: 'key missing' }, { status: 400 });
    const ok = deleteCacheEntry(key);
    return NextResponse.json({ key, deleted: ok });
  } catch (e) {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
}
