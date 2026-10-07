import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Minimal key/value persistence port.
 *
 * Phase 1 uses AsyncStorage (localStorage on web). Before handling real
 * applicant data, swap this for an encrypted store — application drafts
 * contain DOB and surname. See KNOWN LIMITATIONS in docs/PHASE_1_REPORT.md.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const deviceStorage: KeyValueStorage = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};

export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  dump(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    async getItem(k) {
      return map.get(k) ?? null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}
