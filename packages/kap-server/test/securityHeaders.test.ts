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

function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    directives.set(tokens[0] as string, tokens.slice(1));
  }
  return directives;
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

  it('allows inline styles while keeping inline scripts forbidden', async () => {
    const { headers, reply } = captureHeaders();
    const hook = createSecurityHeadersHook({ tls: false });
    await hook({} as never, reply as never, 'payload');
    const csp = headers.get('content-security-policy');
    expect(csp).toBeDefined();
    const directives = parseCsp(csp ?? '');
    const styleSrc = directives.get('style-src');
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("'unsafe-inline'");
    const effectiveScriptSrc = directives.get('script-src') ?? directives.get('default-src');
    expect(effectiveScriptSrc).toBeDefined();
    expect(effectiveScriptSrc).not.toContain("'unsafe-inline'");
    expect(effectiveScriptSrc).not.toContain("'unsafe-eval'");
    expect(effectiveScriptSrc).not.toContain('data:');
  });

  it('allows WebAssembly compilation without allowing JavaScript eval', async () => {
    const { headers, reply } = captureHeaders();
    await createSecurityHeadersHook({ tls: false })({} as never, reply as never, 'payload');
    const directives = parseCsp(headers.get('content-security-policy') ?? '');
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('allows data and blob media fetches on the existing API origin', async () => {
    const { headers, reply } = captureHeaders();
    await createSecurityHeadersHook({ tls: false })({} as never, reply as never, 'payload');
    const directives = parseCsp(headers.get('content-security-policy') ?? '');
    expect(directives.get('connect-src')).toEqual(["'self'", 'data:', 'blob:']);
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
