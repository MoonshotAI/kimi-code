import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { ARTEX_ASSET_TYPES } from '#/features/artex/protocol/index';
import type { ArtexAssetInput } from '#/features/artex/store/artexWorkStore';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { evaluateAssetGate } from '#/features/artex/safety/assetGate';
import { isIpLiteral } from '#/features/artex/safety/net';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveWork } from '../toolSupport';
import DESCRIPTION from './insert_assets.md?raw';

const AssetItemSchema = z.object({
  type: z.enum(ARTEX_ASSET_TYPES),
  domain: z.string().optional(),
  icp: z.string().optional(),
  record_type: z.string().optional(),
  record_value: z.array(z.string()).optional(),
  ip: z.string().optional(),
  bound_domains: z.array(z.string()).optional(),
  open_ports: z
    .array(
      z.object({
        port: z.number().int(),
        service: z.string().optional(),
        protocol: z.string().optional(),
      }),
    )
    .optional(),
  app_name: z.string().optional(),
  bundle_id: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  app_icp: z.string().optional(),
  company_id: z.number().int().optional(),
  url: z.string().optional(),
  technologies: z.array(z.string()).optional(),
  status_code: z.number().int().optional(),
  content_length: z.number().int().optional(),
  page_title: z.string().optional(),
  favicon_mmh3: z.string().optional(),
  auth: z.array(z.record(z.string(), z.unknown())).optional(),
  service_name: z.string().optional(),
  service_ip: z.string().optional(),
  port: z.number().int().optional(),
  proto: z.string().optional(),
  method: z.string().optional(),
  params: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const InsertAssetsInputSchema = z.object({
  assets: z.array(AssetItemSchema),
});

export type InsertAssetsInput = z.infer<typeof InsertAssetsInputSchema>;
type AssetItem = z.infer<typeof AssetItemSchema>;

const PARAMETERS = toInputJsonSchema(InsertAssetsInputSchema);

export const IArtexInsertAssetsTool: ServiceIdentifier<AgentTool<InsertAssetsInput>> =
  createDecorator<AgentTool<InsertAssetsInput>>('artexInsertAssetsTool');

interface AssetGateCandidates {
  readonly domains: string[];
  readonly ips: string[];
  readonly urls: string[];
}

function assetInputCandidates(item: AssetItem): AssetGateCandidates {
  const domains: string[] = [];
  const ips: string[] = [];
  const urls: string[] = [];
  const add = (dst: string[], value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') dst.push(trimmed);
  };
  add(domains, item.domain);
  for (const bound of item.bound_domains ?? []) add(domains, bound);
  add(ips, item.ip);
  add(ips, item.service_ip);
  add(urls, item.url);
  if (item.url !== undefined && item.url.trim() !== '') {
    const host = urlHost(item.url);
    if (host !== undefined) {
      if (isIpLiteral(host)) add(ips, host);
      else add(domains, host);
    }
  }
  return { domains, ips, urls };
}

function urlHost(raw: string): string | undefined {
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const hostname = url.hostname;
    if (hostname === '') return undefined;
    if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
    return hostname;
  } catch {
    return undefined;
  }
}

function assetInputLabel(item: AssetItem): string {
  const target =
    firstNonEmpty(item.domain) ??
    firstNonEmpty(item.url) ??
    firstNonEmpty(item.ip) ??
    firstNonEmpty(item.service_ip) ??
    '(unknown)';
  return `[${item.type}] ${target}`;
}

function firstNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
}

function toAssetInput(item: AssetItem): ArtexAssetInput {
  return {
    type: item.type,
    domain: item.domain,
    icp: item.icp,
    recordType: item.record_type,
    recordValue: item.record_value,
    ip: item.ip,
    boundDomains: item.bound_domains,
    openPorts: item.open_ports,
    appName: item.app_name,
    bundleId: item.bundle_id,
    category: item.category,
    description: item.description,
    appIcp: item.app_icp,
    companyId: item.company_id,
    url: item.url,
    technologies: item.technologies,
    statusCode: item.status_code,
    contentLength: item.content_length,
    pageTitle: item.page_title,
    faviconMmh3: item.favicon_mmh3,
    auth: item.auth,
    serviceName: item.service_name,
    serviceIp: item.service_ip,
    port: item.port,
    proto: item.proto,
    method: item.method,
    params: item.params,
  };
}

export class ArtexInsertAssetsTool implements AgentTool<InsertAssetsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'insert_assets' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: InsertAssetsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Registering ARTEX assets',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: InsertAssetsInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store, taskId } = handle;

    const global = await store.listAssetInterceptRules();
    const split = await store.taskInterceptRulesSplit(taskId);
    const blockRules = [...global, ...split.block];
    const allowRules = split.allow;

    const results: { index: number; id: number; type: string }[] = [];
    const errors: { index: number; error: string }[] = [];

    for (let index = 0; index < args.assets.length; index += 1) {
      const item = args.assets[index]!;
      const { domains, ips, urls } = assetInputCandidates(item);
      const gate = evaluateAssetGate(blockRules, allowRules, domains, ips, urls);
      if (!gate.allowed) {
        errors.push({
          index,
          error: `asset ${assetInputLabel(item)} ${gate.reason}; insertion forbidden`,
        });
        continue;
      }
      try {
        const upsert = await store.upsertAsset(toAssetInput(item), taskId);
        results.push({ index, id: upsert.id, type: item.type });
        await store.addAutoScope(
          taskId,
          item.type,
          item.domain ?? '',
          item.url ?? '',
          item.service_ip ?? item.ip ?? '',
        );
      } catch (error) {
        errors.push({ index, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { output: artexJson({ results, errors }) };
  }
}
