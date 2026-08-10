/**
 * Local `effectiveModelAlias` — the subset the extension consumes, replacing
 * the node-sdk import (G-1 vscode localization). Merges user `overrides`,
 * drops a `defaultEffort` the overrides no longer support, and clamps
 * `maxInputSize` to `maxContextSize`. The Anthropic-profile inference of the
 * original is deliberately omitted — the extension only reads
 * `supportEfforts` from the result.
 */

import type { ModelAlias } from "./types";

/** Resolve a model alias's effective config (node-sdk parity, simplified). */
export function effectiveModelAlias(alias: ModelAlias): ModelAlias {
  const { overrides, ...base } = alias;
  const effective: ModelAlias = overrides === undefined ? alias : { ...base, ...overrides };

  if (
    overrides?.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    const { defaultEffort: _drop, ...rest } = effective;
    return clampInputSize(rest);
  }

  return clampInputSize(effective);
}

function clampInputSize(model: ModelAlias): ModelAlias {
  if (
    model.maxInputSize !== undefined &&
    model.maxContextSize !== undefined &&
    model.maxInputSize > model.maxContextSize
  ) {
    return { ...model, maxInputSize: model.maxContextSize };
  }
  return model;
}
