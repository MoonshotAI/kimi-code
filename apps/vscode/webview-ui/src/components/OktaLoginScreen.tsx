import { useState, useEffect } from "react";
import { IconLoader2, IconCopy, IconCheck, IconExternalLink, IconArrowRight } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { KimiMascot } from "./KimiMascot";
import { bridge, Events } from "@/services";

interface OktaLoginScreenProps {
  onLoginSuccess: () => void;
  onSkip: () => void;
  /** Why the Okta module could not be armed (missing/invalid okta.json). */
  initError?: string | null;
}

type LoginState = "idle" | "pending" | "error";

export function OktaLoginScreen({ onLoginSuccess, onSkip, initError }: OktaLoginScreenProps) {
  const [state, setState] = useState<LoginState>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initError ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return bridge.on<{ url: string }>(Events.OktaLoginUrl, ({ url }) => {
      setUrl(url);
    });
  }, []);

  // The mode RPC resolves after mount; surface its failure here.
  useEffect(() => {
    if (initError !== null && initError !== undefined) setError(initError);
  }, [initError]);

  const handleLogin = async () => {
    setState("pending");
    setUrl(null);
    setError(null);
    try {
      const result = await bridge.oktaLogin();
      if (result.success) {
        onLoginSuccess();
      } else {
        setState("error");
        setError(result.error || "Login failed");
      }
    } catch (error) {
      setState("error");
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCopyUrl = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  if (state === "pending") {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-6">
          <KimiMascot className="h-12 mx-auto" />
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-blue-500">
              <IconLoader2 className="size-5 animate-spin" />
              <span className="text-sm font-medium">Waiting for authentication…</span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground text-left">A browser window should open automatically. Complete the sign-in process there.</p>
          </div>
          {url && (
            <div className="bg-muted/50 rounded-lg p-2 text-left space-y-3">
              <p className="text-xs text-muted-foreground">If the browser didn&apos;t open, visit this URL:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 font-mono break-all select-all">{url}</code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 size-8"
                  onClick={() => {
                    void handleCopyUrl();
                  }}
                >
                  {copied ? <IconCheck className="size-4 text-emerald-500" /> : <IconCopy className="size-4" />}
                </Button>
              </div>
              <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-blue-500 hover:underline">
                <IconExternalLink className="size-3.5" />
                Open in browser
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-sm w-full text-center space-y-6">
        <KimiMascot className="h-12 mx-auto" />
        <div className="space-y-2">
          <h1 className="text-lg font-semibold">Welcome to Kimi Code</h1>
          <div className="text-left space-y-2">
            <p className="text-xs leading-5">Sign in with your organization account to use the models provided by your gateway.</p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2 text-left">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="space-y-5">
          <div className="text-left space-y-1">
            <Button
              onClick={() => {
                void handleLogin();
              }}
              className="w-full justify-center gap-2"
            >
              Sign in with Okta
            </Button>
            <p className="text-[11px] text-muted-foreground leading-4">Opens your browser and returns to VS Code automatically.</p>
          </div>

          <div className="text-left space-y-1">
            <Button type="button" variant="outline" onClick={onSkip} className="w-full relative justify-center font-normal">
              <span>Skip</span>
              <IconArrowRight className="size-4 text-muted-foreground absolute right-3" />
            </Button>
            <p className="text-[11px] text-muted-foreground leading-4">Use your existing API key configuration.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
