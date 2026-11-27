import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { isDarkVscodeTheme } from "@/lib/theme";

function syncTheme() {
  document.documentElement.classList.toggle("dark", isDarkVscodeTheme(document.body));
}

syncTheme();

const observer = new MutationObserver(syncTheme);
observer.observe(document.body, {
  attributes: true,
  attributeFilter: ["class", "data-vscode-theme-kind"],
});

const container = document.getElementById("root");

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
