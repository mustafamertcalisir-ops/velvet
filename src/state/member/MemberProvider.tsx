import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { MemberApi } from '@/services/api/memberTypes';
import { useAdmissionActions, useAdmissionGetState } from '@/state/admission/AdmissionProvider';
import { createMemberStore, type MemberState, type MemberStore } from './memberStore';

const MemberContext = createContext<MemberStore | null>(null);

/**
 * Mounted only inside the member boundary (src/app/member/_layout.tsx), so it
 * never exists for applicants. State is in memory and discarded on unmount.
 */
export function MemberProvider({ api, children }: { api: MemberApi; children: ReactNode }) {
  const getAdmission = useAdmissionGetState();
  const admission = useAdmissionActions();
  const [store] = useState(() =>
    createMemberStore({
      api,
      getSession: () => getAdmission().session,
      onUnauthorized: (kind) => {
        // A lost session signs out; lost membership access re-reads the lifecycle so the guard can redirect.
        if (kind === 'unauthorized') void admission.signOut();
        else void admission.refresh();
      },
    }),
  );
  useEffect(() => () => store.actions.reset(), [store]);
  return <MemberContext.Provider value={store}>{children}</MemberContext.Provider>;
}

function useStore(): MemberStore {
  const store = useContext(MemberContext);
  if (!store) throw new Error('Member hooks must be used inside <MemberProvider>');
  return store;
}

export function useMember<T>(selector: (s: MemberState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}

export function useMemberActions() {
  return useStore().actions;
}
