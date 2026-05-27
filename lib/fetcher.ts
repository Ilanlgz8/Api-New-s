// Fetcher générique pour SWR
export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const error = new Error('Erreur API') as Error & { status?: number; info?: unknown };
    error.status = res.status;
    error.info = await res.json().catch(() => ({}));
    throw error;
  }
  return res.json();
};
