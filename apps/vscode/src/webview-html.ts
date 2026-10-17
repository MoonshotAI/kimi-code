export interface WebviewHtmlOptions {
  readonly origin: string;
  readonly token?: string;
}

export function buildKimiUrl(origin: string, token?: string): string {
  const base = `${origin}/?kimi_origin=${encodeURIComponent(origin)}`;
  return token !== undefined && token.length > 0
    ? `${base}#token=${encodeURIComponent(token)}`
    : base;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}

export function buildWebviewHtml(opts: WebviewHtmlOptions): string {
  const url = buildKimiUrl(opts.origin, opts.token);
  const csp = `default-src 'none'; frame-src ${opts.origin} http://127.0.0.1:* http://localhost:* https://127.0.0.1:*; style-src 'unsafe-inline'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
.loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; font-family: sans-serif; color: #888; }
iframe { position: fixed; inset: 0; border: 0; width: 100%; height: 100%; }
</style>
</head>
<body>
<div class="loading">Loading Kimi…</div>
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-clipboard-read allow-clipboard-write" src="${escapeHtmlAttr(url)}"></iframe>
</body>
</html>`;
}

export function buildErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body { font-family: sans-serif; padding: 1em; } pre { white-space: pre-wrap; color: #b00; }</style>
</head>
<body>
<h3>Kimi server unavailable</h3>
<pre>${escapeHtmlAttr(message)}</pre>
</body>
</html>`;
}
