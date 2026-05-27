export function errorMessage(error: unknown, fallback = 'Erreur inconnue') {
  return error instanceof Error ? error.message : fallback;
}
