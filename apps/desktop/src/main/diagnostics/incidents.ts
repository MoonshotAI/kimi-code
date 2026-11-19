import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';
import type { WebContents } from 'electron';

import { capturePageStats, describeProcesses, probePage } from './collector';
import {
  INCIDENTS_DIR,
  launchChannel,
  launchId,
  log,
  logsDir,
  recentLogLines,
  startupTimeline,
  tildify,
  uptimeMs,
} from './log';

const MAX_INCIDENT_CHARS = 512 * 1024;

export interface IncidentInput {
  kind: string;
  summary: string;
  contents?: WebContents | null;
  details?: Record<string, unknown>;
}

export function incidentFileName(kind: string, now: Date = new Date(), pid: number = process.pid): string {
  return `${now.toISOString().replaceAll(/[:.]/g, '-')}-${kind}-${pid}.json`;
}

export function serializeIncident(incident: Record<string, unknown> & { recentLog: string[] }): string {
  let recentLog = incident.recentLog;
  let json = JSON.stringify({ ...incident, recentLog }, null, 2);
  while (json.length > MAX_INCIDENT_CHARS && recentLog.length > 0) {
    recentLog = recentLog.slice(Math.ceil(recentLog.length / 2));
    json = JSON.stringify({ ...incident, recentLog }, null, 2);
  }
  return json;
}

async function pageEvidence(contents: WebContents | null | undefined): Promise<Record<string, unknown>> {
  if (contents === null || contents === undefined || contents.isDestroyed()) return {};
  const [page, screenshot] = await Promise.all([probePage(contents), capturePageStats(contents)]);
  return { page, screenshot };
}

export async function writeIncident(input: IncidentInput): Promise<string | null> {
  try {
    const incident = {
      kind: input.kind,
      summary: input.summary,
      at: new Date().toISOString(),
      launchId: launchId(),
      pid: process.pid,
      version: app.getVersion(),
      channel: launchChannel(),
      uptimeMs: uptimeMs(),
      timeline: startupTimeline(),
      gpuFeatures: app.getGPUFeatureStatus(),
      processes: describeProcesses(),
      ...(await pageEvidence(input.contents)),
      ...input.details,
      recentLog: recentLogLines(),
    };
    const dir = join(logsDir(), INCIDENTS_DIR);
    await mkdir(dir, { recursive: true });
    const path = join(dir, incidentFileName(input.kind));
    await writeFile(path, serializeIncident(incident));
    log.warn(`[white-screen] ${input.summary} incident=${tildify(path)}`);
    return path;
  } catch (error) {
    log.warn(`[white-screen] ${input.summary} (incident not written: ${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}
