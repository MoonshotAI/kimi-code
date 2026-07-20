import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

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
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
