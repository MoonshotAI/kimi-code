import type {
  ArtexAssetInterceptRule,
  ArtexTargetPin,
  IArtexWorkStore,
} from '#/features/artex/store/artexWorkStore';

import type { IArtexTargetPinCache } from './artexTargetPinCache';

import { matchAssetInterceptRules } from './assetGate';
import { cidrContainsIp, parseCidr } from './net';
import { extractDeclaredTargets } from './targetExtract';
import type { IArtexTargetResolver } from './targetResolver';
import { targetName, type ArtexTarget } from './target';

export const ARTEX_TARGET_RESOLVE_FAILED = 'TARGET_RESOLVE_FAILED';
export const ARTEX_TARGET_RULE_BLOCKED = 'TARGET_RULE_BLOCKED';
export const ARTEX_TARGET_TOO_MANY = 'TARGET_TOO_MANY';
export const ARTEX_TARGET_GATE_UNAVAILABLE = 'TARGET_GATE_UNAVAILABLE';
export const ARTEX_TARGET_APPROVAL_PENDING = 'TARGET_APPROVAL_PENDING';
export const ARTEX_TARGET_DENIED = 'TARGET_DENIED';

/** How many distinct unpinned targets one call may request approval for. */
export const ARTEX_MAX_UNPINNED_TARGETS = 5;

const LITERAL_RESOLVER = 'literal';

/**
 * The guidance appended to each target block message, telling the model what the
 * block means for its next step. Ported from ARTEX guard.targetGuidance.
 */
export const ARTEX_TARGET_GUIDANCE: Readonly<Record<string, string>> = {
  [ARTEX_TARGET_APPROVAL_PENDING]:
    'The call was not executed. An approval by the operator is needed and may still arrive: retry the same call later. ' +
    'Do not rewrite the command, switch tools or substitute an IP address.',
  [ARTEX_TARGET_DENIED]:
    'The call was not executed. The operator did not approve this target: do not retry it and do not reach it another way.',
  [ARTEX_TARGET_RESOLVE_FAILED]:
    'The call was not executed and no approval was requested. ' +
    'This is a resolver failure on the platform side, not a block by the target. ' +
    'Do not rewrite the command, switch tools or substitute an IP address. Retry the same call later, or report the failure.',
  [ARTEX_TARGET_RULE_BLOCKED]:
    'The call was not executed and no approval was requested. ' +
    "The operator's rules exclude this target: do not reach it another way.",
  [ARTEX_TARGET_TOO_MANY]:
    'The call was not executed and no approval was requested. Name fewer new targets per call.',
  [ARTEX_TARGET_GATE_UNAVAILABLE]:
    'The call was not executed. This is a failure on the platform side, not a block by the target. ' +
    'Retry the same call later, or report the failure.',
};

export interface ArtexTargetRequest {
  readonly host: string;
  readonly port: number;
  readonly kind: ArtexTarget['kind'];
  readonly resolvedIps: readonly string[];
  readonly resolver: string;
  readonly resolvedAt: string;
}

export interface ArtexTargetGateBlock {
  readonly code: string;
  readonly reason: string;
  readonly host?: string;
  readonly port?: number;
  readonly guidance?: string;
}

export interface ArtexTargetGateResult {
  readonly unpinned: readonly ArtexTargetRequest[];
  readonly block?: ArtexTargetGateBlock;
}

export interface ArtexTargetGateInput {
  readonly store: IArtexWorkStore;
  readonly resolver: IArtexTargetResolver;
  readonly taskId: number;
  readonly toolName: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
  readonly pinCache?: IArtexTargetPinCache;
}

interface CheckedTarget {
  readonly target: ArtexTarget;
  ips: readonly string[];
  resolver: string;
  resolvedAt: string;
  err?: Error;
}

/**
 * Decides, for one tool call, whether every network target it declares may be
 * reached: extraction, asset block rules (pre-resolution), resolution, exemptions
 * and the pin lookup. It creates no approval request and never waits. A block is
 * returned in {@link ArtexTargetGateResult.block}; otherwise the returned
 * requests are the targets no pin covers. No request and no block means the call
 * may run. Ported from ARTEX intercept.CheckTargets.
 */
export async function checkArtexTargets(input: ArtexTargetGateInput): Promise<ArtexTargetGateResult> {
  const { store, resolver, taskId, toolName, args, signal, pinCache } = input;
  const declared = extractDeclaredTargets(toolName, args);
  if (declared.targets.length === 0) return { unpinned: [] };

  let blockRules: readonly ArtexAssetInterceptRule[];
  let exemptions: ReadonlySet<string>;
  try {
    const global = await store.listAssetInterceptRules();
    const scoped = await store.taskInterceptRulesSplit(taskId);
    blockRules = [...global, ...scoped.block];
    exemptions = new Set((await store.targetExemptions()).map((entry) => entry.trim().toLowerCase()));
  } catch (error) {
    const first = declared.targets[0];
    return {
      unpinned: [],
      block: gateBlock(ARTEX_TARGET_GATE_UNAVAILABLE, reasonOf(error), first),
    };
  }

  const urlHit = matchAssetInterceptRules(blockRules, [], [], declared.urls);
  if (urlHit !== undefined) {
    const first = declared.targets[0];
    return {
      unpinned: [],
      block: gateBlock(
        ARTEX_TARGET_RULE_BLOCKED,
        `${urlHit.value} is blocked by an asset rule. ${ruleReason(urlHit.rule)}`,
        first,
      ),
    };
  }

  const checked: CheckedTarget[] = declared.targets.map((target) => ({
    target,
    ips: target.kind === 'domain' ? [] : [target.host],
    resolver: target.kind === 'domain' ? '' : LITERAL_RESOLVER,
    resolvedAt: target.kind === 'domain' ? '' : new Date().toISOString(),
  }));

  for (const ct of checked) {
    const hit = blockRuleFor(blockRules, ct);
    if (hit !== undefined) {
      return {
        unpinned: [],
        block: gateBlock(
          ARTEX_TARGET_RULE_BLOCKED,
          `${targetName(ct.target)} is blocked by an asset rule. ${ruleReason(hit.rule)}`,
          ct.target,
        ),
      };
    }
  }

  for (const ct of checked) {
    if (ct.target.kind !== 'domain') continue;
    if (isExempt(exemptions, ct.target)) continue;
    await resolveInto(ct, resolver, signal);
    if (ct.err !== undefined) continue;
    const hit = blockRuleFor(blockRules, ct);
    if (hit !== undefined) {
      return {
        unpinned: [],
        block: gateBlock(
          ARTEX_TARGET_RULE_BLOCKED,
          `${targetName(ct.target)} is blocked by an asset rule. ${ruleReason(hit.rule)}`,
          ct.target,
        ),
      };
    }
  }

  const unpinned: ArtexTargetRequest[] = [];
  for (const ct of checked) {
    if (isExempt(exemptions, ct.target) && exemptionHolds(ct)) continue;
    if (ct.err !== undefined) {
      return {
        unpinned: [],
        block: gateBlock(ARTEX_TARGET_RESOLVE_FAILED, resolveFailure(ct), ct.target),
      };
    }
    let pins: readonly ArtexTargetPin[];
    try {
      const durable = await store.activeTargetPins(taskId, ct.target.host, ct.target.port);
      const cached = pinCache?.activePins(taskId, ct.target.host, ct.target.port) ?? [];
      pins = [...durable, ...cached];
    } catch (error) {
      return {
        unpinned: [],
        block: gateBlock(ARTEX_TARGET_GATE_UNAVAILABLE, `the pins could not be read: ${reasonOf(error)}`, ct.target),
      };
    }
    if (coveringPin(pins, ct.ips) !== undefined) continue;
    if (!hasRequest(unpinned, ct.target.host, ct.target.port)) {
      unpinned.push({
        host: ct.target.host,
        port: ct.target.port,
        kind: ct.target.kind,
        resolvedIps: ct.ips,
        resolver: ct.resolver,
        resolvedAt: ct.resolvedAt,
      });
    }
  }

  if (unpinned.length > ARTEX_MAX_UNPINNED_TARGETS) {
    const names = unpinned.map((request) => targetName(request)).join(', ');
    const first = unpinned[0];
    return {
      unpinned: [],
      block: gateBlock(
        ARTEX_TARGET_TOO_MANY,
        `this call names ${String(unpinned.length)} targets that are not approved (${names}); at most ${String(ARTEX_MAX_UNPINNED_TARGETS)} are requested per call`,
        first === undefined ? undefined : { host: first.host, port: first.port },
      ),
    };
  }

  return { unpinned };
}

async function resolveInto(
  ct: CheckedTarget,
  resolver: IArtexTargetResolver,
  signal: AbortSignal | undefined,
): Promise<void> {
  ct.resolver = resolver.resolverName;
  try {
    const result = await resolver.lookup(ct.target.host, signal);
    ct.ips = result.ips;
    ct.resolvedAt = result.resolvedAt;
    ct.err = undefined;
  } catch (error) {
    ct.ips = [];
    ct.err = error instanceof Error ? error : new Error(String(error));
  }
}

function resolveFailure(ct: CheckedTarget): string {
  return `the platform could not resolve ${ct.target.host} (${ct.err?.message ?? 'unknown error'})`;
}

function coveringPin(pins: readonly ArtexTargetPin[], resolved: readonly string[]): ArtexTargetPin | undefined {
  for (const pin of pins) {
    if (pin.nameOnlyEffective || subset(resolved, pin.pinnedIps)) return pin;
  }
  return undefined;
}

function subset(inner: readonly string[], outer: readonly string[]): boolean {
  if (inner.length === 0) return false;
  const set = new Set(outer);
  return inner.every((value) => set.has(value));
}

function hasRequest(list: readonly ArtexTargetRequest[], host: string, port: number): boolean {
  return list.some((request) => request.host === host && request.port === port);
}

function blockRuleFor(
  rules: readonly ArtexAssetInterceptRule[],
  ct: CheckedTarget,
): { readonly rule: ArtexAssetInterceptRule } | undefined {
  let domains: readonly string[] = [];
  let ips = ct.ips;
  if (ct.target.kind === 'domain') {
    domains = [ct.target.host];
  } else if (ct.target.kind === 'cidr') {
    const parsed = parseCidr(ct.target.host);
    ips = parsed === undefined ? [ct.target.host] : [ct.target.host, parsed.base];
  }
  const hit = matchAssetInterceptRules(rules, domains, ips, []);
  return hit === undefined ? undefined : { rule: hit.rule };
}

function ruleReason(rule: ArtexAssetInterceptRule): string {
  const note = rule.note.trim();
  return note === '' ? `asset rule ${rule.pattern}` : note;
}

function isExempt(exemptions: ReadonlySet<string>, target: ArtexTarget): boolean {
  if (exemptions.size === 0) return false;
  return (
    exemptions.has(targetName(target).toLowerCase()) || exemptions.has(target.host.toLowerCase())
  );
}

function exemptionHolds(ct: CheckedTarget): boolean {
  if (ct.target.kind === 'ip') return !isLocalOrPrivateIp(ct.target.host);
  if (ct.target.kind !== 'domain' || ct.err !== undefined || ct.ips.length === 0) return false;
  return !ct.ips.some(isLocalOrPrivateIp);
}

function isLocalOrPrivateIp(ip: string): boolean {
  if (ip === '100.100.100.200') return true;
  if (
    cidrContainsIp('127.0.0.0/8', ip) ||
    cidrContainsIp('10.0.0.0/8', ip) ||
    cidrContainsIp('172.16.0.0/12', ip) ||
    cidrContainsIp('192.168.0.0/16', ip) ||
    cidrContainsIp('169.254.0.0/16', ip) ||
    cidrContainsIp('0.0.0.0/8', ip) ||
    cidrContainsIp('224.0.0.0/4', ip)
  ) {
    return true;
  }
  const lower = ip.toLowerCase();
  if (
    lower === '::' ||
    lower === '::1' ||
    cidrContainsIp('fe80::/10', ip) ||
    cidrContainsIp('ff00::/8', ip)
  ) {
    return true;
  }
  return lower.startsWith('fc') || lower.startsWith('fd');
}

function gateBlock(
  code: string,
  reason: string,
  target: Pick<ArtexTarget, 'host' | 'port'> | undefined,
): ArtexTargetGateBlock {
  return {
    code,
    reason,
    host: target?.host,
    port: target?.port !== undefined && target.port > 0 ? target.port : undefined,
    guidance: ARTEX_TARGET_GUIDANCE[code],
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
