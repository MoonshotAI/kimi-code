

import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/agent-core';


export const KIMI_SERVER_LABEL = 'ai.moonshot.kimi-server';


export const KIMI_SERVER_PLIST_FILENAME = `${KIMI_SERVER_LABEL}.plist`;


export const KIMI_SERVER_SYSTEMD_UNIT = 'kimi-server.service';


export const KIMI_SERVER_TASK_NAME = 'KimiServer';


export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', KIMI_SERVER_PLIST_FILENAME);
}


export function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', KIMI_SERVER_SYSTEMD_UNIT);
}


export function supervisorLogPath(): string {
  return join(resolveKimiHome(), 'server', 'server.log');
}


export function installPlanPath(): string {
  return join(resolveKimiHome(), 'server', 'install.json');
}


export function guiDomain(uid: number = process.getuid?.() ?? 0): string {
  return `gui/${uid}`;
}
