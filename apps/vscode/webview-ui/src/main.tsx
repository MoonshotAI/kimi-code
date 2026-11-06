import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { bridge } from "./services";

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

const markViewActive = () => {
  void bridge.markViewActive();
};
window.addEventListener("focus", markViewActive);
window.addEventListener("pointerdown", markViewActive, { capture: true });
window.addEventListener("keydown", markViewActive, { capture: true });

const container = document.querySelector("#root");

const queryClient = new QueryClient();

if (container) {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
