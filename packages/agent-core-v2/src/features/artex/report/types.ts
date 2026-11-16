import type {
  ArtexAsset,
  ArtexCoverageLedger,
  ArtexExploration,
  ArtexFinding,
  ArtexFindingNode,
  ArtexTaskScope,
} from '#/features/artex/protocol/index';
import type { ArtexActivityEntry } from '#/features/artex/store/artexGraphStore';
import type { ArtexTrafficBinding, ArtexTrafficRole } from '#/features/artex/store/artexTrafficStore';

export interface ArtexReportInput {
  readonly title: string;
  readonly goal: string;
  readonly generatedAt?: Date | string;
  readonly assetCounts?: Readonly<Record<string, number>>;
  readonly findings: readonly ArtexFindingNode[];
  readonly coverage?: ArtexCoverageLedger;
  readonly exploration?: ArtexExploration;
  readonly scopes?: readonly ArtexTaskScope[];
  readonly assets?: readonly ArtexAsset[];
  readonly methodology?: string | readonly string[];
  readonly timeline?: readonly ArtexActivityEntry[];
}

export interface ArtexExportFinding extends ArtexFinding {
  readonly taskDescription?: string;
  readonly trafficBindings?: readonly ArtexTrafficBinding[];
}

export interface ArtexFindingsExportOptions {
  readonly generatedAt?: Date | string;
  readonly summaryFilename?: string;
  readonly csvFilename?: string;
}

export interface ArtexExportAttachmentEntry {
  readonly findingId: number;
  readonly bindingId: number;
  readonly role: ArtexTrafficRole;
  readonly side: 'request' | 'response';
  readonly archivePath: string;
  readonly head: string;
  readonly blobHash?: string;
  readonly blobRelativePath?: string;
  readonly bodyLength: number;
}

export interface ArtexFindingExportEntry {
  readonly findingId: number;
  readonly filename: string;
  readonly archivePath: string;
  readonly markdown: string;
  readonly attachments: readonly ArtexExportAttachmentEntry[];
}

export interface ArtexFindingsExportManifest {
  readonly generatedAt: string;
  readonly summaryPath: string;
  readonly summaryMarkdown: string;
  readonly csvPath: string;
  readonly csvContent: string;
  readonly findings: readonly ArtexFindingExportEntry[];
  readonly attachments: readonly ArtexExportAttachmentEntry[];
}
