import { posix } from 'node:path';

import type { ArtexTrafficBinding } from '#/features/artex/store/artexTrafficStore';

import { formatReportTimestamp, nonEmptyOr, severityOrder } from './report';
import type {
  ArtexExportAttachmentEntry,
  ArtexExportFinding,
  ArtexFindingExportEntry,
  ArtexFindingsExportManifest,
  ArtexFindingsExportOptions,
} from './types';

const UNSAFE_FILENAME_CHARS_RE = /[^\p{Script=Han}\p{L}\p{N}._-]+/gu;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const FORMULA_PREFIX_RE = /^[\t\r=+\-@]/;
const MAX_FILENAME_BASE_RUNES = 120;

function epochMillis(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export function sortFindingsForExport<T extends ArtexExportFinding>(
  findings: readonly T[],
): T[] {
  return findings
    .map((item, idx) => ({ item, idx }))
    .toSorted(
      (a, b) =>
        severityOrder(a.item.severity) - severityOrder(b.item.severity) ||
        epochMillis(b.item.createdAt) - epochMillis(a.item.createdAt) ||
        a.idx - b.idx,
    )
    .map((entry) => entry.item);
}

function findingTitle(finding: ArtexExportFinding): string {
  return nonEmptyOr(finding.name, nonEmptyOr(finding.vulnclass, 'Uncategorized'));
}

function findingTrafficIds(finding: ArtexExportFinding): string {
  return (finding.trafficBindings ?? []).map((b) => String(b.id)).join(',');
}

function renderTrafficMarkdown(
  finding: ArtexExportFinding,
  includeAttachments: boolean,
): string {
  const bindings: readonly ArtexTrafficBinding[] = finding.trafficBindings ?? [];
  const stale =
    finding.report !== '' &&
    finding.evidenceVersion !== finding.reportEvidenceVersion;
  if (bindings.length === 0 && !stale) return '';

  const lines: string[] = [
    '',
    '## Related Traffic Evidence',
    '',
    `Evidence version: ${String(finding.evidenceVersion)}; bindings: ${String(bindings.length)}.`,
    '',
  ];
  if (stale) {
    lines.push('The evidence has changed; the detailed report needs updating.', '');
  }
  for (let i = 0; i < bindings.length; i += 1) {
    const b = bindings[i]!;
    const safeUrl = b.snapshot.url.replaceAll('`', '%60');
    lines.push(
      `${String(i + 1)}. **Evidence #${String(b.id)} · ${b.role}** — \`${b.snapshot.method} ${safeUrl}\`, status ${String(b.snapshot.status)}`,
    );
    if (b.note !== '') {
      lines.push(`   ${b.note.replaceAll('\n', '\n   ')}`);
    }
    if (includeAttachments) {
      const fId = safePositiveIntSegment(finding.id);
      const bId = safePositiveIntSegment(b.id);
      lines.push(
        `   [Request message](evidence/${fId}/${bId}/request.http) · [Response message](evidence/${fId}/${bId}/response.http)`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function renderFindingsMarkdown(
  findings: readonly ArtexExportFinding[],
  generatedAt?: Date | string,
): string {
  const items = sortFindingsForExport(findings);
  const lines: string[] = [
    '# Vulnerability Findings Summary Report',
    '',
    `- **Generated at**: ${formatReportTimestamp(generatedAt)}`,
    `- **Total findings**: ${String(items.length)}`,
    '',
  ];

  const counts: Record<string, number> = {};
  for (const f of items) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }

  lines.push('## Summary', '');
  lines.push('| Severity | Count |', '| --- | --- |');
  const rows: readonly [string, string][] = [
    ['critical', 'Critical'],
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
  ];
  for (const [key, label] of rows) {
    lines.push(`| ${label} | ${String(counts[key] ?? 0)} |`);
  }
  lines.push('');

  if (items.length === 0) {
    lines.push('_No matching vulnerabilities._', '');
    return lines.join('\n');
  }

  lines.push('## Vulnerability Details', '');
  for (let i = 0; i < items.length; i += 1) {
    const f = items[i]!;
    const sevLabel = nonEmptyOr(f.severity, 'info').toUpperCase();
    lines.push(`### ${String(i + 1)}. [${sevLabel}] ${findingTitle(f)}`, '');
    if (f.vulnclass !== '') {
      lines.push(`- **Class**: ${f.vulnclass}`);
    }
    lines.push(`- **Status**: ${nonEmptyOr(f.status, 'pending')}`);
    const desc = f.taskDescription?.trim() ?? '';
    if (desc !== '') {
      lines.push(`- **Task**: ${desc}`);
    }
    lines.push(`- **Found at**: ${formatReportTimestamp(f.createdAt)}`, '');
    const summary = f.summary.trim();
    if (summary !== '') {
      lines.push(summary, '');
    }
    const evidence = f.evidence.trim();
    if (evidence !== '') {
      lines.push('**Evidence:**', '', '```', evidence, '```', '');
    }
    const rep = f.report.trim();
    if (rep !== '') {
      lines.push('**Detailed report:**', '', rep, '', '');
    }
    const trafficMd = renderTrafficMarkdown(f, false);
    if (trafficMd !== '') lines.push(trafficMd);
    lines.push('---', '');
  }

  return lines.join('\n');
}

export function renderSingleFindingMarkdown(
  finding: ArtexExportFinding,
  generatedAt?: Date | string,
): string {
  const lines: string[] = [];
  const sevLabel = nonEmptyOr(finding.severity, 'info').toUpperCase();
  lines.push(`# [${sevLabel}] ${findingTitle(finding)}`, '');
  if (finding.vulnclass !== '') {
    lines.push(`- **Class**: ${finding.vulnclass}`);
  }
  lines.push(`- **Severity**: ${nonEmptyOr(finding.severity, 'info')}`);
  lines.push(`- **Status**: ${nonEmptyOr(finding.status, 'pending')}`);
  const desc = finding.taskDescription?.trim() ?? '';
  if (desc !== '') {
    lines.push(`- **Task**: ${desc}`);
  }
  lines.push(`- **Found at**: ${formatReportTimestamp(finding.createdAt)}`);
  lines.push(`- **Generated at**: ${formatReportTimestamp(generatedAt)}`, '');

  const summary = finding.summary.trim();
  if (summary !== '') {
    lines.push('## Summary', '', summary, '');
  }
  const evidence = finding.evidence.trim();
  if (evidence !== '') {
    lines.push('## Evidence', '', '```', evidence, '```', '');
  }
  const rep = finding.report.trim();
  if (rep !== '') {
    lines.push('## Detailed Report', '', rep);
  }
  const trafficMd = renderTrafficMarkdown(finding, true);
  if (trafficMd !== '') lines.push(trafficMd);
  return lines.join('\n');
}

export function safeFindingFilename(finding: Pick<ArtexExportFinding, 'id' | 'severity' | 'name' | 'vulnclass'>): string {
  const sev = nonEmptyOr(finding.severity, 'info');
  const title = nonEmptyOr(finding.name, nonEmptyOr(finding.vulnclass, 'Uncategorized'));
  let name = `${sev}_${title}_${String(finding.id)}`
    .replaceAll('\0', '')
    .replaceAll(UNSAFE_FILENAME_CHARS_RE, '_')
    .replaceAll(/\.\.+/g, '_')
    .replaceAll(/_+/g, '_')
    .replaceAll(/^[._]+|[._]+$/g, '');

  name = posix.basename(name).replaceAll(/[/\\]/g, '_');
  if (name === '' || name === '.' || name === '..') {
    name = `finding_${safePositiveIntSegment(finding.id)}`;
  }

  const runes = Array.from(name);
  if (runes.length > MAX_FILENAME_BASE_RUNES) {
    name = runes.slice(0, MAX_FILENAME_BASE_RUNES).join('').replaceAll(/[._]+$/g, '');
    if (name === '' || name === '.' || name === '..') {
      name = `finding_${safePositiveIntSegment(finding.id)}`;
    }
  }
  return `${name}.md`;
}

export function sanitizeZipArchivePath(rawPath: string): string {
  const cleaned = rawPath.replaceAll('\0', '').replaceAll('\\', '/').trim();
  if (cleaned === '' || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
    throw new Error(`unsafe archive path: ${rawPath}`);
  }
  const segments = cleaned.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.length === 0 || segments.some((seg) => seg === '..')) {
    throw new Error(`unsafe archive path: ${rawPath}`);
  }
  const normalized = posix.normalize(segments.join('/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`unsafe archive path: ${rawPath}`);
  }
  return normalized;
}

function escapeCsvCell(raw: string, neutralizeFormula: boolean): string {
  let value = raw;
  if (neutralizeFormula && value !== '' && FORMULA_PREFIX_RE.test(value)) {
    value = `'${value}`;
  }
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function renderFindingsCsv(findings: readonly ArtexExportFinding[]): string {
  const items = sortFindingsForExport(findings);
  const header = [
    'ID',
    'Name',
    'Class',
    'Severity',
    'Status',
    'Task',
    'Found At',
    'Summary',
    'Traffic Evidence Count',
    'Traffic Evidence IDs',
  ]
    .map((cell) => escapeCsvCell(cell, false))
    .join(',');

  const rows = items.map((f) => {
    const bindings = f.trafficBindings ?? [];
    const cells: readonly [string, boolean][] = [
      [String(f.id), false],
      [findingTitle(f), true],
      [f.vulnclass, true],
      [nonEmptyOr(f.severity, 'info'), false],
      [nonEmptyOr(f.status, 'pending'), false],
      [f.taskDescription ?? '', true],
      [formatReportTimestamp(f.createdAt), false],
      [f.summary.trim(), true],
      [String(bindings.length), false],
      [findingTrafficIds(f), false],
    ];
    return cells.map(([val, formulaGuard]) => escapeCsvCell(val, formulaGuard)).join(',');
  });

  return `\uFEFF${[header, ...rows].join('\r\n')}\r\n`;
}

export function renderFindingsCsvBuffer(findings: readonly ArtexExportFinding[]): Buffer {
  return Buffer.from(renderFindingsCsv(findings), 'utf8');
}

function safePositiveIntSegment(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  return String(Math.floor(value));
}

function blobRelativePathForHash(hash: string): string | undefined {
  if (!SHA256_HEX_RE.test(hash)) return undefined;
  return `blobs/${hash.slice(0, 2)}/${hash}.bin`;
}

function deduplicateArchivePath(candidate: string, used: Set<string>, findingId: number): string {
  const safe = sanitizeZipArchivePath(candidate);
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const ext = posix.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let attempt = sanitizeZipArchivePath(`${stem}_${safePositiveIntSegment(findingId)}${ext}`);
  let suffix = 2;
  while (used.has(attempt)) {
    attempt = sanitizeZipArchivePath(`${stem}_${safePositiveIntSegment(findingId)}_${String(suffix)}${ext}`);
    suffix += 1;
  }
  used.add(attempt);
  return attempt;
}

export function buildFindingsExportManifest(
  findings: readonly ArtexExportFinding[],
  options: ArtexFindingsExportOptions = {},
): ArtexFindingsExportManifest {
  const generatedAt = formatReportTimestamp(options.generatedAt);
  const summaryPath = sanitizeZipArchivePath(options.summaryFilename ?? 'summary.md');
  const csvPath = sanitizeZipArchivePath(options.csvFilename ?? 'findings.csv');
  const usedPaths = new Set<string>([summaryPath, csvPath]);

  const sorted = sortFindingsForExport(findings);
  const summaryMarkdown = renderFindingsMarkdown(sorted, generatedAt);
  const csvContent = renderFindingsCsv(sorted);

  const findingEntries: ArtexFindingExportEntry[] = [];
  const allAttachments: ArtexExportAttachmentEntry[] = [];

  for (const finding of sorted) {
    const baseFilename = safeFindingFilename(finding);
    const archivePath = deduplicateArchivePath(baseFilename, usedPaths, finding.id);
    const filename = posix.basename(archivePath);
    const markdown = renderSingleFindingMarkdown(finding, generatedAt);
    const findingAttachments: ArtexExportAttachmentEntry[] = [];
    const fSeg = safePositiveIntSegment(finding.id);

    for (const binding of finding.trafficBindings ?? []) {
      const bSeg = safePositiveIntSegment(binding.id);
      const sides: readonly {
        readonly side: 'request' | 'response';
        readonly file: string;
        readonly head: string;
        readonly hash: string;
        readonly length: number;
      }[] = [
        {
          side: 'request',
          file: 'request.http',
          head: binding.snapshot.reqHead,
          hash: binding.snapshot.reqHash,
          length: binding.snapshot.reqLen,
        },
        {
          side: 'response',
          file: 'response.http',
          head: binding.snapshot.respHead,
          hash: binding.snapshot.respHash,
          length: binding.snapshot.respLen,
        },
      ];

      for (const s of sides) {
        const attPath = deduplicateArchivePath(`evidence/${fSeg}/${bSeg}/${s.file}`, usedPaths, finding.id);
        const validHash = SHA256_HEX_RE.test(s.hash) ? s.hash : undefined;
        const entry: ArtexExportAttachmentEntry = {
          findingId: finding.id,
          bindingId: binding.id,
          role: binding.role,
          side: s.side,
          archivePath: attPath,
          head: s.head,
          blobHash: validHash,
          blobRelativePath: validHash !== undefined ? blobRelativePathForHash(validHash) : undefined,
          bodyLength: s.length,
        };
        findingAttachments.push(entry);
        allAttachments.push(entry);
      }
    }

    findingEntries.push({
      findingId: finding.id,
      filename,
      archivePath,
      markdown,
      attachments: findingAttachments,
    });
  }

  return {
    generatedAt,
    summaryPath,
    summaryMarkdown,
    csvPath,
    csvContent,
    findings: findingEntries,
    attachments: allAttachments,
  };
}
