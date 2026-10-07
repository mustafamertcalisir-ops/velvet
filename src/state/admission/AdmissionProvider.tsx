import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { isServerTracked } from '@/domain/admission/status';
import { createAdmissionStore, type AdmissionState, type AdmissionStore } from './store';

const AdmissionContext = createContext<AdmissionStore | null>(null);

export function AdmissionProvider({
  children,
  createStore,
}: {
  children: ReactNode;
  createStore: () => AdmissionStore;
}) {
  const [store] = useState(createStore);

  useEffect(() => {
    void store.actions.hydrate().then(() => {
      if (isServerTracked(store.getState().status)) void store.actions.refresh();
    });
    // Re-sync status when the app returns to the foreground.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && isServerTracked(store.getState().status)) void store.actions.refresh();
    });
    return () => sub.remove();
  }, [store]);

  return <AdmissionContext.Provider value={store}>{children}</AdmissionContext.Provider>;
}

function useStore(): AdmissionStore {
  const store = useContext(AdmissionContext);
  if (!store) throw new Error('useAdmission must be used inside <AdmissionProvider>');
  return store;
}

export function useAdmission<T>(selector: (s: AdmissionState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

export function useAdmissionActions() {
  return useStore().actions;
}

/** Read the latest state inside an event handler (after an action has just committed). */
export function useAdmissionGetState(): () => AdmissionState {
  return useStore().getState;
}

export { createAdmissionStore };
