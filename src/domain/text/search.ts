/**
 * Locale-safe search folding.
 *
 * "istanbul" must find "İstanbul", "sanliurfa" must find "Şanlıurfa",
 * "IĞDIR" must find "Iğdır". JavaScript's default toLowerCase() turns "İ"
 * into "i̇" (i + combining dot) and leaves "ı" alone, so we decompose, strip
 * marks and map the dotless i explicitly.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rank: exact > prefix > word-prefix > contains. Returns -1 for no match. */
export function matchScore(query: string, candidates: readonly string[]): number {
  const q = foldForSearch(query);
  if (!q) return 0;
  let best = -1;
  for (const c of candidates) {
    const f = foldForSearch(c);
    if (f === q) return 3;
    if (f.startsWith(q)) best = Math.max(best, 2);
    else if (f.split(/[\s\-(),]+/).some((w) => w.startsWith(q))) best = Math.max(best, 1);
    else if (f.includes(q)) best = Math.max(best, 0);
  }
  return best;
}

export function searchBy<T>(
  items: readonly T[],
  query: string,
  keys: (item: T) => readonly string[],
): T[] {
  if (!foldForSearch(query)) return [...items];
  return items
    .map((item, index) => ({ item, index, score: matchScore(query, keys(item)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
