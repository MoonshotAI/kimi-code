import { useEffect, useState } from "react";
import { bridge } from "@/services";

export type AuthMode = "kimi" | "okta";

export interface AuthModeState {
  readonly mode: AuthMode;
  /** Why the Okta module could not be armed; shown on the Okta login page. */
  readonly error: string | null;
}

const INITIAL: AuthModeState = { mode: "okta", error: null };

let cached: Promise<AuthModeState> | undefined;

function fetchAuthMode(): Promise<AuthModeState> {
  // Okta is the default; a failed RPC keeps the Okta page AND surfaces the
  // error there instead of silently falling back.
  cached ??= bridge.getAuthMode().catch((error): AuthModeState => ({
    mode: "okta",
    error: error instanceof Error ? error.message : String(error),
  }));
  return cached;
}

/**
 * Which login surface to show, plus any arming error to display on the Okta
 * page. Cached module-wide so remounting the login view does not refetch.
 */
export function useAuthMode(): AuthModeState {
  const [state, setState] = useState<AuthModeState>(INITIAL);
  useEffect(() => {
    let cancelled = false;
    void fetchAuthMode().then((resolved) => {
      if (!cancelled) setState(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
