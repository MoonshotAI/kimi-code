import { mkdir } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.js';
import { migrationReportFile } from './paths.js';
import type { MigrationReport } from './types.js';

export async function writeReport(
  targetHome: string,
  report: MigrationReport,
): Promise<void> {
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  await atomicWrite(migrationReportFile(targetHome), JSON.stringify(report, null, 2));
}
