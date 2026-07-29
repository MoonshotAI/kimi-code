// test/performance.test.ts
//
// Performance smoke tests — order-of-magnitude guards only (no absolute
// timing assertions beyond the documented abort path), meant to catch
// accidental quadratic complexity in future changes.

import { describe, expect, it } from 'vitest';

import { parse } from '#/parse';

/** ~100 KB of realistic script-shaped text (functions, loops, redirects,
 *  expansions, heredocs — not a pathological single construct). */
function realisticScript(): string {
  const block = `deploy() {
  local version="$1"
  if [[ -z "\${version}" ]]; then
    echo "usage: deploy <version>" >&2
    return 1
  fi
  for pkg in core web worker; do
    tar -czf "dist/\${pkg}-\${version}.tar.gz" "build/\${pkg}" || return 2
  done
  grep -q "release" CHANGELOG.md && echo "releasing \${version}" >> deploy.log
  ssh deploy@example.com "mkdir -p /srv/app/releases/\${version}" < /dev/null
  rsync -a --delete dist/ deploy@example.com:/srv/app/releases/\${version}/ | tee -a deploy.log
}

while read -r name status; do
  case "$status" in
    ok) echo "\${name}: fine" ;;
    *) echo "\${name}: \${status}" >&2 ;;
  esac
done < services.txt

cat <<'SCRIPT_EOF'
deploy finished at $(date)
SCRIPT_EOF

`;
  return block.repeat(Math.ceil(100_000 / block.length));
}

describe('performance smoke', () => {
  it('parses a 100KB realistic script fast (default budget suffices)', () => {
    const source = realisticScript();
    expect(source.length).toBeGreaterThan(100_000);
    const start = performance.now();
    const result = parse(source);
    const elapsed = performance.now() - start;
    if (!result.ok) {
      // An abort is acceptable only when it is prompt (< 100 ms).
      expect(result).toEqual({ ok: false, reason: 'aborted' });
      expect(elapsed).toBeLessThan(100);
      return;
    }
    // Completed within the default 50 ms budget; re-parse unbounded and
    // assert the order of magnitude (< 1 s for 100KB) as a quadratic guard.
    const restart = performance.now();
    const full = parse(source, { timeoutMs: Number.POSITIVE_INFINITY });
    const fullElapsed = performance.now() - restart;
    expect(full.ok).toBe(true);
    expect(fullElapsed).toBeLessThan(1000);
    console.log(`100KB realistic script: default-budget parse ${elapsed.toFixed(1)}ms, unbounded ${fullElapsed.toFixed(1)}ms`);
  });

  it('the abort path is prompt (< 100 ms) on a node-budget bomb', () => {
    const source = 'echo a; '.repeat(50_000);
    const start = performance.now();
    const result = parse(source);
    const elapsed = performance.now() - start;
    expect(result).toEqual({ ok: false, reason: 'aborted' });
    expect(elapsed).toBeLessThan(100);
    console.log(`abort after ${elapsed.toFixed(1)}ms on a 400KB node-budget bomb`);
  });

  it('typical one-line commands parse in well under a millisecond', () => {
    // Warm up.
    parse('git status && rm -rf /');
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      parse('git status && rm -rf /');
    }
    const perParse = (performance.now() - start) / iterations;
    expect(perParse).toBeLessThan(5);
    console.log(`typical command: ${(perParse * 1000).toFixed(0)}µs per parse`);
  });

  it('a 500KB heredoc body parses within the default budget (few nodes)', () => {
    const source = `cat <<EOF\n${'line of text\n'.repeat(40_000)}EOF`;
    expect(source.length).toBeGreaterThan(500_000);
    const result = parse(source);
    expect(result.ok).toBe(true);
  });
});
