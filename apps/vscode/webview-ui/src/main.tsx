import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

function syncTheme() {
  const isDark = document.body.classList.contains("vscode-dark");
  document.documentElement.classList.toggle("dark", isDark);
}

syncTheme();

const observer = new MutationObserver(syncTheme);
observer.observe(document.body, {
  attributes: true,
  attributeFilter: ["class"],
});

const container = document.getElementById("root");

if (container) {
  try {
    const root = createRoot(container);
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch (err) {
    console.error("[Kimi Webview] Failed to mount React root:", err);
    container.innerHTML = `<div style="padding:16px;font-family:sans-serif;color:var(--foreground,red)">Kimi Code: failed to load webview. Please run <b>Kimi Code: Open in Side Bar</b> or reload the window.</div>`;
  }
}
