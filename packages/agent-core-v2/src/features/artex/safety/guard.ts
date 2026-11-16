import type { IArtexWorkStore } from '#/features/artex/store/artexWorkStore';
import { artexSystemBlockMessage, artexTargetBlockMessage } from '#/features/artex/prompts/index';

import type { ArtexBashParse } from './argv';
import {
  matchInterceptRules,
  type ArtexInterceptDecision,
  type ArtexInterceptMatchOptions,
} from './interceptRules';
import { checkArtexTargets, type ArtexTargetRequest } from './targetGate';
import type { IArtexTargetResolver } from './targetResolver';
import type { IArtexTargetPinCache } from './artexTargetPinCache';

export type ArtexGateDecision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'deny'; readonly message: string }
  | {
      readonly kind: 'ask-target';
      readonly requests: readonly ArtexTargetRequest[];
      readonly rule?: ArtexInterceptDecision;
    }
  | { readonly kind: 'ask-rule'; readonly rule: ArtexInterceptDecision };

export interface ArtexGateInput {
  readonly store: IArtexWorkStore;
  readonly resolver: IArtexTargetResolver;
  readonly taskId: number;
  readonly toolName: string;
  readonly args: unknown;
  readonly parse: ArtexBashParse;
  readonly signal?: AbortSignal;
  readonly ruleOptions?: ArtexInterceptMatchOptions;
  readonly pinCache?: IArtexTargetPinCache;
}

/**
 * Evaluates the ARTEX safety spine for one tool call: the user-configurable
 * intercept rules first (a deny blocks outright), then the target gate (a block
 * vetoes, an uncovered target asks). Ported from ARTEX guard.applyIntercept.
 *
 * The invariant the gate guarantees: a tool call that declares a target no pin or
 * exemption covers is never passed through silently — it is asked (an approval
 * request) or denied (a block). A target that fails to resolve is denied with
 * TARGET_RESOLVE_FAILED, never allowed.
 */
export async function evaluateArtexGate(input: ArtexGateInput): Promise<ArtexGateDecision> {
  const { store, resolver, taskId, toolName, args, parse, signal, ruleOptions } = input;
  await store.ensureSeeded();

  const inputText = safeStringify(args);
  const command = commandOf(args);
  const rules = await store.listInterceptRules();
  const ruleDecision = matchInterceptRules(rules, toolName, inputText, command, parse, ruleOptions);
  if (ruleDecision !== undefined && ruleDecision.action === 'deny') {
    return { kind: 'deny', message: artexSystemBlockMessage(ruleDecision.message) };
  }
  const ruleAsk = ruleDecision !== undefined && ruleDecision.action === 'ask' ? ruleDecision : undefined;

  const target = await checkArtexTargets({
    store,
    resolver,
    taskId,
    toolName,
    args,
    signal,
    pinCache: input.pinCache,
  });
  if (target.block !== undefined) {
    return { kind: 'deny', message: artexTargetBlockMessage(target.block) };
  }
  if (target.unpinned.length > 0) {
    return { kind: 'ask-target', requests: target.unpinned, rule: ruleAsk };
  }
  if (ruleAsk !== undefined) {
    return { kind: 'ask-rule', rule: ruleAsk };
  }
  return { kind: 'pass' };
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function safeStringify(args: unknown): string {
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return '';
  }
}
