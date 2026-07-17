import { describe, expect, it } from 'vitest';

import { createSecurityHeadersHook } from '../src/middleware/securityHeaders';

function captureHeaders() {
  const headers = new Map<string, string>();
  const reply = {
    header(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return reply;
    },
  };
  return { headers, reply };
}

describe('createSecurityHeadersHook', () => {
  it('stamps the defensive headers and returns the payload unchanged', async () => {
    const { headers, reply } = captureHeaders();
    const hook = createSecurityHeadersHook({ tls: false });
    const payload = { ok: true };
    const result = await hook({} as never, reply as never, payload);
    expect(result).toBe(payload);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('content-security-policy')).toBeDefined();
  });

  // KaTeX math and Shiki highlighting are injected via innerHTML with
  // per-glyph `style="…"` attributes (KaTeX carries ALL vertical/font sizing
  // in them — stripping collapses formulas into overlapping glyphs), and
  // Mermaid embeds an inline <style> in its SVG. style-src must therefore
  // allow inline styles; script-src must stay strict.
  it('allows inline styles while keeping inline scripts forbidden', async () => {
    const { headers, reply } = captureHeaders();
    const hook = createSecurityHeadersHook({ tls: false });
    await hook({} as never, reply as never, 'payload');
    const csp = headers.get('content-security-policy');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("default-src 'self'");
  });

  it('emits HSTS only when TLS is terminated at the server', async () => {
    const plain = captureHeaders();
    await createSecurityHeadersHook({ tls: false })({} as never, plain.reply as never, '');
    expect(plain.headers.has('strict-transport-security')).toBe(false);

    const tls = captureHeaders();
    await createSecurityHeadersHook({ tls: true })({} as never, tls.reply as never, '');
    expect(tls.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
