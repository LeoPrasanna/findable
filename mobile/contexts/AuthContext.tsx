// App-wide auth state from Supabase. Subscribes to session changes so the UI
// reacts immediately to login / logout / token refresh.
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { api } from '../services/api';
import { resetSessionFlags } from '../services/sessionFlags';
import * as billing from '../services/billing';
import { refreshUsage, clearUsage } from '../services/usageCache';
import { clearLibraryEdits } from '../services/libraryEdits';
import { clearLibraryIndex } from '../services/libraryIndex';
import { clearThumbRefreshes } from '../services/thumbRefresh';
import { ensureShareKey, clearShareKey } from '../services/shareKey';

/**
 * ⚠️ The optional fields are `string | null`, and the null is the point.
 *
 * `updateProfile` merges into existing metadata and sends it as JSON, and
 * `JSON.stringify` drops undefined keys. So `{nickname: undefined}` shipped a
 * payload with no `nickname` at all, Supabase merged nothing, and the old value
 * survived on the server — a field the user had just cleared came back at the
 * next token refresh. Callers clearing a field MUST pass null, which serialises.
 */
export interface Profile {
  first_name?: string | null;
  last_name?: string | null;
  nickname?: string | null;
  /** Key into the illustrated avatar set (e.g. `18_astronaut`), or a legacy
   *  emoji character for accounts that picked one before 2026-08-10. Replaced
   *  the earlier gender field (2026-07-24): asking someone's gender to choose a
   *  glyph collected personal data the app has no use for, and the answer was
   *  never really about identity — people just want a face they like. */
  avatar?: string | null;
}

/**
 * Pick-your-face options — now 102 illustrated avatars, not emoji
 * (owner, 2026-08-10). The list itself lives in `constants/avatars.ts`
 * alongside the `require()` map, because Metro needs static literals.
 *
 * ⚠️ The stored value's MEANING changed: it used to be the emoji character
 * itself, it is now an asset key like `18_astronaut`. Nothing was migrated on
 * purpose — an account that picked '🎧' still has '🎧' in `profiles.avatar`,
 * and every render site falls back to drawing an unrecognised value as text.
 * So old faces keep rendering, new picks get artwork, and no backfill can go
 * half-done. See `isLegacyAvatar` in constants/avatars.ts.
 */
export { AVATAR_KEYS as AVATAR_OPTIONS } from '../constants/avatars';

interface AuthState {
  session: Session | null;
  loading: boolean;          // true until the initial session check resolves
  email: string | null;
  profile: Profile;          // from Supabase user_metadata
  displayName: string;       // what to address them by: nickname > first name > email
  celebrate: boolean;        // one-shot: play the welcome confetti over the whole app
  triggerCelebrate: () => void;
  updateProfile: (fields: Profile) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<{ error: string | null }>;
}

// Friendly fallback name from the email local-part, e.g. "prasanna.a1@x.com" ->
// "Prasanna" — used only until the user sets a real first name / nickname.
function nameFromEmail(email?: string | null): string {
  const local = (email?.split('@')[0] || '').split(/[._\-+0-9]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1).toLowerCase() : 'there';
}

const AuthContext = createContext<AuthState>({
  session: null,
  loading: true,
  email: null,
  profile: {},
  displayName: 'there',
  celebrate: false,
  triggerCelebrate: () => {},
  updateProfile: async () => ({ error: null }),
  signOut: async () => {},
  deleteAccount: async () => ({ error: null }),
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [celebrate, setCelebrate] = useState(false);

  // Fired on successful sign-in. Lives here (not in LoginScreen) because the auth
  // gate unmounts LoginScreen the instant a session exists — so the confetti must
  // be owned above the gate to survive the login→app transition.
  const triggerCelebrate = () => {
    setCelebrate(true);
    setTimeout(() => setCelebrate(false), 2400);
  };

  useEffect(() => {
    let mounted = true;

    // Restore any persisted session on cold start.
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
      // Warm the account state (tier, AI budget, counts) the moment we know who
      // this is — see the note on the SIGNED_IN branch below.
      if (data.session) {
        /**
         * ⚠️ REVENUECAT MUST KNOW THE SUPABASE USER ID, and this is where it
         * learns it. The billing webhook decides WHOSE tier to change from
         * `event.app_user_id`; if the SDK is left to invent an anonymous id, a
         * real purchase arrives at the server attached to nobody and the money is
         * taken with no entitlement granted. Both branches below call it —
         * cold start as well as SIGNED_IN — because a returning user never fires
         * a SIGNED_IN event.
         */
        billing.identify(data.session.user.id);
        refreshUsage();
        // Re-minted on EVERY launch, not only at sign-in. The server snapshots
        // the tier and quota identity into the key (a share-key request has no
        // JWT to read them from), so re-minting is what keeps a user who just
        // upgraded to Pro from sharing on a stale free-tier snapshot.
        ensureShareKey();
      }
    });

    // React to sign-in / sign-out / token refresh for the app's lifetime.
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      // A real auth transition resets session-scoped UI flags so the next user
      // starts at the Landing screen (not wherever the last user navigated).
      // Token refreshes must NOT reset — they fire mid-session.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') resetSessionFlags();

      /**
       * ⚠️ FETCH ACCOUNT STATE AT LOGIN, NOT WHEN A SCREEN ASKS FOR IT.
       *
       * The profile panel, the save screen and the reel screen each fetched
       * `/usage` on open/mount, so every one of them painted placeholder
       * numbers first and corrected them a moment later — "0 saved" and no
       * tier badge, for the length of a round-trip. On a cold Render free
       * instance that is ~50 seconds of the panel stating things that are
       * simply untrue.
       *
       * Nothing about that data is screen-specific; only the moment we asked
       * for it was. Fetching here means it is already in hand before the user
       * can reach any of those screens, and each one reads the cache
       * synchronously for its first paint.
       *
       * Not awaited, and failure is swallowed inside refreshUsage: the gate
       * must not wait on a meter, and a signed-in user with an unreachable
       * backend still gets their app.
       */
      if (event === 'SIGNED_IN') {
        if (next?.user?.id) billing.identify(next.user.id);   // see the cold-start note above
        refreshUsage(); ensureShareKey();
      }
      // Never let the next account inherit the previous one's tier or counts,
      // a pending delete / category override from their library, or the
      // ability to keep saving into their account silently from the share sheet.
      if (event === 'SIGNED_OUT') {
        clearUsage(); clearLibraryEdits(); clearShareKey(); clearLibraryIndex();
        clearThumbRefreshes();
        // Same reason as the rest of this list: the next account on this device
        // must not inherit the last one's purchase identity.
        billing.forget();
      }

      setSession(next);
      setLoading(false);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const updateProfile = async (fields: Profile): Promise<{ error: string | null }> => {
    // Merge into existing metadata so we never wipe fields the form didn't touch.
    const current = (session?.user?.user_metadata ?? {}) as Profile;
    const { data, error } = await supabase.auth.updateUser({ data: { ...current, ...fields } });
    if (error) return { error: error.message };
    if (data.user) setSession(s => (s ? { ...s, user: data.user } : s));
    return { error: null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const deleteAccount = async (): Promise<{ error: string | null }> => {
    try {
      // 1. Delete all user data + the auth record on the backend. If this fails
      // we STOP — signing out anyway would tell the user their data was erased
      // when it wasn't.
      await api.deleteAccount();
    } catch (e: any) {
      return { error: e?.message || "Couldn't delete your data — check your connection and try again." };
    }
    // 2. Clear the local session. Scope 'local' only — the server-side session
    // is already dead (the auth user was just deleted), so a server sign-out
    // would fail and previously made a successful deletion LOOK broken.
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Local storage clear can't meaningfully fail; the gate flips on the
      // auth listener either way.
    }
    return { error: null };
  };

  const email = session?.user?.email ?? null;
  const profile = (session?.user?.user_metadata ?? {}) as Profile;
  const displayName =
    profile.nickname?.trim() || profile.first_name?.trim() || nameFromEmail(email);

  return (
    <AuthContext.Provider
      value={{ session, loading, email, profile, displayName, celebrate, triggerCelebrate, updateProfile, signOut, deleteAccount }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
