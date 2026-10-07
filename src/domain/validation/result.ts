export type Validation<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const valid = <T>(value: T) => ({ ok: true as const, value });
export const invalid = <E extends string>(error: E) => ({ ok: false as const, error });
