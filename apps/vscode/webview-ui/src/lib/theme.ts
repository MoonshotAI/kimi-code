export function isDarkVscodeTheme(body: HTMLElement): boolean {
  const kind = body.dataset.vscodeThemeKind;
  if (kind) {
    return kind === "vscode-dark" || kind === "vscode-high-contrast";
  }
  return body.classList.contains("vscode-dark")
    || (body.classList.contains("vscode-high-contrast") && !body.classList.contains("vscode-high-contrast-light"));
}
