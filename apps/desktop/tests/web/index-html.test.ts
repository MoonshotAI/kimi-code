
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(fileURLToPath(new URL('../../src/renderer/index.html', import.meta.url)), 'utf-8');
const bootJsPath = fileURLToPath(new URL('../../src/renderer/public/boot.js', import.meta.url));

describe('index.html CSP hygiene', () => {
  it('has no <script> tag without a src attribute', () => {
    const scriptTags = indexHtml.match(/<script\b[^>]*>/gi) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toMatch(/\bsrc\s*=/);
    }
  });

  it('has no inline event-handler attributes', () => {
    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('loads the anti-FOUC bootstrap from the external /boot.js', () => {
    expect(indexHtml).toContain('<script src="/boot.js"></script>');
    expect(existsSync(bootJsPath)).toBe(true);
  });
});
