import { existsSync, readFileSync } from 'node:fs';

const file = '.changeset/release-plan.json';
if (!existsSync(file)) process.exit(1);
const plan = JSON.parse(readFileSync(file, 'utf8'));
const pkg = JSON.parse(readFileSync('apps/vscode/package.json', 'utf8'));
const synced = plan.branch?.startsWith('release/') && plan.packages?.some(item => item.path === 'apps/vscode' && item.name === pkg.name && item.version === pkg.version);
process.exit(synced ? 0 : 1);
