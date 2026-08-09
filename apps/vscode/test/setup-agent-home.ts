/**
 * Test isolation for the engine's persistent store. `KIMI_AGENT_HOME` (set in
 * vitest.config env) points at a shared scratch dir under test/; the dir must
 * exist before the first engine subprocess spawns, or concurrent workers race
 * to create it. This setup file runs in every worker before any test import.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agentHome = fileURLToPath(new URL('./.agent-home', import.meta.url));
mkdirSync(agentHome, { recursive: true });
process.env['KIMI_AGENT_HOME'] = agentHome;
