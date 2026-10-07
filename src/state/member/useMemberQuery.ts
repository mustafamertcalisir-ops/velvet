import { useCallback, useEffect, useState } from 'react';

import type { ApiError, ApiResult } from '@/services/api/types';

export type Query<T> =
  | { status: 'loading'; value: T | null; error: null }
  | { status: 'ready'; value: T; error: null }
  | { status: 'error'; value: T | null; error: ApiError };

/**
 * Load something from the member API for one screen, keyed by `key`.
 * `initial` lets a screen render immediately from memory (e.g. a profile
 * already seen on Home) while the server is asked again. Results for a
 * superseded key or attempt are ignored.
 */
export function useMemberQuery<T>(load: () => Promise<ApiResult<T>>, key: string, initial: T | null = null) {
  const [attempt, setAttempt] = useState(0);
  const token = `${key}#${attempt}`;
  const [result, setResult] = useState<{ token: string; res: ApiResult<T> } | null>(null);
  const [last, setLast] = useState<{ key: string; value: T } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load().then((res) => {
      if (cancelled) return;
      setResult({ token, res });
      if (res.ok) setLast({ key, value: res.value });
    });
    return () => {
      cancelled = true;
    };
    // `load` is recreated each render; the key (and attempt) say when to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const current = result?.token === token ? result.res : null;
  const kept = last?.key === key ? last.value : initial;
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const query: Query<T> = !current
    ? { status: 'loading', value: kept, error: null }
    : current.ok
      ? { status: 'ready', value: current.value, error: null }
      : { status: 'error', value: kept, error: current.error };
  return { ...query, reload };
}
