import { LoginScreen } from "./LoginScreen";
import { OktaLoginScreen } from "./OktaLoginScreen";
import { useAuthMode } from "../hooks/useAuthMode";

interface LoginScreenGateProps {
  onLoginSuccess: () => void;
  onSkip: () => void;
}

/**
 * Picks the login surface by auth mode. Okta is the default; the Kimi login
 * only shows when okta.json opts out via "authMode": "kimi". Mode resolution
 * errors (missing/invalid okta.json, RPC failure) stay on the Okta page and
 * render as its error banner.
 */
export function LoginScreenGate({ onLoginSuccess, onSkip }: LoginScreenGateProps) {
  const { mode, error } = useAuthMode();
  return mode === "okta" ? (
    <OktaLoginScreen onLoginSuccess={onLoginSuccess} onSkip={onSkip} initError={error} />
  ) : (
    <LoginScreen onLoginSuccess={onLoginSuccess} onSkip={onSkip} />
  );
}
