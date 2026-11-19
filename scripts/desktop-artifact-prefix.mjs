const override = (process.env.ARTIFACT_PREFIX ?? '').trim();
if (override && (/[/\\":<>|*?\p{Cc}]/u.test(override) || override.length > 200)) {
  throw new Error('Artifact prefix must be at most 200 characters and contain no path separators, control characters or ":<>|*?');
}

const branch = (process.env.GITHUB_REF_NAME ?? '')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^[.-]+|[.-]+$/g, '')
  .slice(0, 160) || 'ref';
const channel = process.env.PREVIEW === 'true' ? 'preview-' : process.env.CANARY === 'true' ? 'canary-' : '';
const prefix = override || `kimi-code-${channel}${branch}`;
process.stdout.write(`prefix=${prefix}\n`);
