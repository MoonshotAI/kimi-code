import { bridge } from "@/services";

let isProgrammaticCopy = false;

export function isPerformingProgrammaticCopy(): boolean {
  return isProgrammaticCopy;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return true;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Document may not be focused in VS Code iframe; continue to fallback
    }
  }

  try {
    const result = await bridge.copyToClipboard(text);
    if (result?.ok) {
      return true;
    }
  } catch {
    // Continue to fallback
  }

  if (typeof document !== "undefined") {
    let textarea: HTMLTextAreaElement | undefined;
    const activeElement = document.activeElement as HTMLElement | null;
    try {
      isProgrammaticCopy = true;
      textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "-9999px";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.focus();
      textarea.select();
      const success = document.execCommand("copy");
      if (success) return true;
    } catch {
      // Ignore
    } finally {
      if (textarea) {
        textarea.remove();
      }
      if (activeElement && typeof activeElement.focus === "function") {
        activeElement.focus();
      }
      isProgrammaticCopy = false;
    }
  }

  return false;
}
