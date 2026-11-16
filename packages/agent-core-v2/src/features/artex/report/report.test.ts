import { describe, expect, it } from 'vitest';

import { buildCoverageLedger, coverageCompletenessFor } from '#/features/artex/logic/coverageLedger';
import type {
  ArtexCoverageEntry,
  ArtexFindingNode,
  ArtexTaskScope,
} from '#/features/artex/protocol/index';
import type { ArtexActivityEntry } from '#/features/artex/store/artexGraphStore';
import type { ArtexTrafficBinding } from '#/features/artex/store/artexTrafficStore';

import {
  REPORT_MAX_GAPS,
  buildFindingsExportManifest,
  renderFindingsCsv,
  renderFindingsCsvBuffer,
  renderFindingsMarkdown,
  renderMarkdownReport,
  renderSingleFindingMarkdown,
  safeFindingFilename,
  sanitizeZipArchivePath,
  type ArtexExportFinding,
} from './index';

function findingNode(
  id: number,
  payload: Record<string, unknown>,
): ArtexFindingNode {
  return {
    id,
    explorationId: 1,
    kind: 'finding',
    state: 'confirmed',
    priority: 5,
    payload,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contentVersion: 1,
  };
}

function makeBinding(id: number, findingNodeId: number, overrides?: Partial<ArtexTrafficBinding>): ArtexTrafficBinding {
  const reqHash = 'a'.repeat(64);
  const respHash = 'b'.repeat(64);
  return {
    id,
    findingNodeId,
    role: 'proof',
    note: 'baseline vs exploit',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    snapshot: {
      id: `snap-${String(id)}`,
      sourceTrafficId: `1000-000${String(id)}`,
      capturedAt: 1700000000,
      url: 'https://target.example.com/login?user=admin`test`',
      method: 'POST',
      status: 200,
      contentType: 'application/json',
      reqHead: 'POST /login HTTP/1.1\r\nHost: target.example.com',
      respHead: 'HTTP/1.1 200 OK\r\nContent-Type: application/json',
      reqHash,
      respHash,
      reqLen: 24,
      respLen: 128,
    },
    ...overrides,
  };
}

function makeFinding(overrides?: Partial<ArtexExportFinding>): ArtexExportFinding {
  return {
    id: 42,
    taskId: 7,
    nodeId: 42,
    vulnclass: 'SQL injection',
    name: 'Login SQL injection',
    severity: 'high',
    summary: 'Unfiltered id parameter allows SQL injection.',
    evidence: "id=1' OR '1'='1",
    worker: 'worker-1',
    assetIds: [1, 2],
    status: 'confirmed',
    report: 'Detailed writeup for SQL injection.',
    poeLevel: 3,
    verificationStatus: 'verified',
    verificationNote: '',
    counterevidence: '',
    confidenceRationale: 'Boolean & time-based confirmation.',
    evidenceVersion: 2,
    reportEvidenceVersion: 2,
    createdAt: '2026-01-02T03:04:05.000Z',
    taskDescription: 'External web penetration test',
    ...overrides,
  };
}

describe('artex report exporter', () => {
  describe('renderMarkdownReport', () => {
    it('renders summary stats, findings sorted by severity, scope, coverage, and timeline', () => {
      const ledger = buildCoverageLedger(
        [{ surface: '/a', riskArea: 'xss', outcome: 'needs_follow_up', evidence: '', reason: '' }],
        ['sqli'],
        coverageCompletenessFor('timeout', false, false, true),
      );
      const scopes: ArtexTaskScope[] = [
        {
          id: 1,
          taskId: 7,
          kind: 'root_domain',
          domain: 'target.example.com',
          source: 'manual',
          reason: 'Authorized scope',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      const timeline: ArtexActivityEntry[] = [
        {
          id: 1,
          actor: 'planner',
          kind: 'dispatch',
          tool: 'start_artex_exploration',
          summary: 'Dispatched initial recon',
          at: '2026-01-01T00:01:00.000Z',
        },
      ];

      const md = renderMarkdownReport({
        title: 'Example Engagement',
        goal: 'Assess authentication and API surface',
        generatedAt: new Date('2026-01-02T12:00:00.000Z'),
        assetCounts: { subdomain: 3, endpoint: 12 },
        findings: [
          findingNode(1, {
            vulnclass: 'info_leak',
            name: 'Server header exposed',
            severity: 'low',
            summary: 'Low severity finding',
            evidence: 'Server: nginx',
          }),
          findingNode(2, {
            vulnclass: 'rce',
            name: 'Command injection',
            severity: 'critical',
            summary: 'Critical RCE',
            evidence: { poc: 'curl -X POST https://target.example.com/run' },
          }),
        ],
        coverage: ledger,
        scopes,
        methodology: ['Black-box HTTP probing', 'Traffic-backed PoC verification'],
        timeline,
      });

      expect(md).toContain('# Penetration Test Report — Example Engagement');
      expect(md).toContain('- **Generated at**: 2026-01-02 12:00:00');
      expect(md).toContain('- Confirmed findings: **2**');
      expect(md).toContain('Critical 1, High 0, Medium 0, Low 1, Info 0');
      expect(md).toContain('- Assets: endpoint 12, subdomain 3');
      expect(md).toContain('## Scope');
      expect(md).toContain('`root_domain`: target.example.com (manual) — Authorized scope');
      expect(md).toContain('## Coverage gaps');
      expect(md).toContain('timeout');
      expect(md).toContain('open gaps: 2');
      expect(md).toContain('- unrecorded_risk_class sqli');
      expect(md).toContain('- needs_follow_up /a xss');
      expect(md).toContain('## Methodology & Timeline');
      expect(md).toContain('Dispatched initial recon');

      const critIdx = md.indexOf('### 1. [CRITICAL] Command injection');
      const lowIdx = md.indexOf('### 2. [LOW] Server header exposed');
      expect(critIdx).toBeGreaterThan(-1);
      expect(lowIdx).toBeGreaterThan(critIdx);
    });

    it('omits coverage section when coverage is undefined and caps gaps at REPORT_MAX_GAPS', () => {
      const noCov = renderMarkdownReport({
        title: 't',
        goal: 'g',
        findings: [],
      });
      expect(noCov).not.toContain('## Coverage gaps');
      expect(noCov).toContain('_No vulnerabilities confirmed this time._');

      const entries: ArtexCoverageEntry[] = [];
      for (let i = 0; i < REPORT_MAX_GAPS + 30; i += 1) {
        entries.push({
          surface: '/p',
          riskArea: 'xss',
          outcome: 'needs_follow_up',
          evidence: '',
          reason: '',
        });
      }
      const capped = renderMarkdownReport({
        title: 't',
        goal: 'g',
        findings: [],
        coverage: buildCoverageLedger(
          entries,
          [],
          coverageCompletenessFor('done', false, false, false),
        ),
      });
      const listed = capped.split('\n- needs_follow_up /p xss').length - 1;
      expect(listed).toBe(REPORT_MAX_GAPS);
      expect(capped).toContain('- and 30 more (see the coverage API)');
    });
  });

  describe('renderFindingsMarkdown & renderSingleFindingMarkdown', () => {
    it('sorts findings by severity then createdAt desc and renders traffic evidence + stale warning', () => {
      const fLow = makeFinding({
        id: 1,
        name: 'Older low',
        severity: 'low',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const fCritOld = makeFinding({
        id: 2,
        name: 'Older critical',
        severity: 'critical',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const fCritNew = makeFinding({
        id: 3,
        name: 'Newer critical',
        severity: 'critical',
        createdAt: '2026-01-03T00:00:00.000Z',
        evidenceVersion: 3,
        reportEvidenceVersion: 2,
        trafficBindings: [makeBinding(10, 3)],
      });

      const summary = renderFindingsMarkdown(
        [fLow, fCritOld, fCritNew],
        new Date('2026-01-04T00:00:00.000Z'),
      );
      expect(summary).toContain('| Critical | 2 |');
      expect(summary).toContain('| Low | 1 |');
      expect(summary.indexOf('Newer critical')).toBeLessThan(summary.indexOf('Older critical'));
      expect(summary.indexOf('Older critical')).toBeLessThan(summary.indexOf('Older low'));
      expect(summary).toContain('The evidence has changed; the detailed report needs updating.');
      expect(summary).toContain('`POST https://target.example.com/login?user=admin%60test%60`');
      expect(summary).not.toContain('evidence/3/10/request.http');

      const single = renderSingleFindingMarkdown(fCritNew, new Date('2026-01-04T00:00:00.000Z'));
      expect(single).toContain('# [CRITICAL] Newer critical');
      expect(single).toContain('[Request message](evidence/3/10/request.http)');
      expect(single).toContain('[Response message](evidence/3/10/response.http)');
    });
  });

  describe('safeFindingFilename & sanitizeZipArchivePath', () => {
    it('prevents zip-slip and path traversal while keeping readable Unicode characters', () => {
      const traversal = safeFindingFilename({
        id: 99,
        severity: 'critical',
        name: '../../../etc/passwd\0..\\\\evil',
        vulnclass: 'path_traversal',
      });
      expect(traversal).not.toContain('..');
      expect(traversal).not.toContain('/');
      expect(traversal).not.toContain('\\');
      expect(traversal).not.toContain('\0');
      expect(traversal.endsWith('.md')).toBe(true);

      const empty = safeFindingFilename({
        id: 7,
        severity: '',
        name: '....////',
        vulnclass: '',
      });
      expect(empty).toBe('info_7.md');

      const cjk = safeFindingFilename({
        id: 12,
        severity: 'high',
        name: '登录接口 SQL 注入',
        vulnclass: 'sqli',
      });
      expect(cjk).toBe('high_登录接口_SQL_注入_12.md');

      const longName = safeFindingFilename({
        id: 5,
        severity: 'medium',
        name: 'a'.repeat(200),
        vulnclass: 'xss',
      });
      expect(Array.from(longName.replace(/\.md$/, '')).length).toBeLessThanOrEqual(120);

      expect(() => sanitizeZipArchivePath('../secret.txt')).toThrow();
      expect(() => sanitizeZipArchivePath('/etc/passwd')).toThrow();
      expect(() => sanitizeZipArchivePath('a/../../b')).toThrow();
      expect(() => sanitizeZipArchivePath('C:\\windows\\win.ini')).toThrow();
      expect(sanitizeZipArchivePath('evidence/1/2/request.http')).toBe(
        'evidence/1/2/request.http',
      );
    });
  });

  describe('renderFindingsCsv', () => {
    it('emits UTF-8 BOM, RFC 4180 CRLF quoting, formula-injection neutralization, and traffic binding columns', () => {
      const csv = renderFindingsCsv([
        makeFinding({
          id: 42,
          name: '=CMD("calc"), "quoted"\nline2',
          vulnclass: '+SUM(1,2)',
          taskDescription: '-evil',
          summary: '@HYPERLINK("https://evil.example.com")',
          trafficBindings: [makeBinding(10, 42), makeBinding(11, 42)],
        }),
      ]);
      const buf = renderFindingsCsvBuffer([makeFinding()]);

      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(buf[0]).toBe(0xef);
      expect(buf[1]).toBe(0xbb);
      expect(buf[2]).toBe(0xbf);
      expect(csv).toContain('\r\n');
      expect(csv).toContain('"\'=CMD(""calc""), ""quoted""\nline2"');
      expect(csv).toContain('"\'+SUM(1,2)"');
      expect(csv).toContain('\'-evil');
      expect(csv).toContain('"\'@HYPERLINK(""https://evil.example.com"")"');
      expect(csv).toContain(',2,"10,11"');
    });
  });

  describe('buildFindingsExportManifest', () => {
    it('builds zip-slip-safe bundle manifest with deduplicated filenames and blob hashes', () => {
      const f1 = makeFinding({
        id: 1,
        name: 'a'.repeat(150),
        trafficBindings: [makeBinding(101, 1)],
      });
      const f2 = makeFinding({
        id: 2,
        name: 'a'.repeat(150),
        trafficBindings: [
          makeBinding(102, 2, {
            snapshot: {
              ...makeBinding(102, 2).snapshot,
              reqHash: 'not-a-valid-hash',
              respHash: 'c'.repeat(64),
            },
          }),
        ],
      });

      const manifest = buildFindingsExportManifest([f1, f2], {
        generatedAt: '2026-01-05T00:00:00.000Z',
      });

      expect(manifest.summaryPath).toBe('summary.md');
      expect(manifest.csvPath).toBe('findings.csv');
      expect(manifest.csvContent.startsWith('\uFEFF')).toBe(true);
      expect(manifest.findings).toHaveLength(2);
      expect(manifest.findings[0]!.archivePath).not.toBe(manifest.findings[1]!.archivePath);
      expect(manifest.attachments).toHaveLength(4);

      const req1 = manifest.attachments[0]!;
      expect(req1.archivePath).toBe('evidence/1/101/request.http');
      expect(req1.blobHash).toBe('a'.repeat(64));
      expect(req1.blobRelativePath).toBe(`blobs/aa/${'a'.repeat(64)}.bin`);

      const req2 = manifest.attachments[2]!;
      expect(req2.blobHash).toBeUndefined();
      expect(req2.blobRelativePath).toBeUndefined();
    });
  });
});
