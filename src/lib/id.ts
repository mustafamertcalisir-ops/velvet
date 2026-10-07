/** Opaque client-side identifiers (idempotency keys, local referral rows). Not security tokens. */
export function createId(prefix: string, random: () => number = Math.random): string {
  const r = Math.floor(random() * 0xffffffff).toString(36);
  return `${prefix}_${Date.now().toString(36)}${r}`;
}
