/**
 * Gateway model provisioning: fetch the catalog from the user's API and
 * write it into config.toml. Every catalog entry carries its OWN inference
 * endpoint (apiBase) and protocol ("provider": openai | openai_responses |
 * anthropic | …), so models are grouped by (protocol, apiBase) — each group
 * becomes one config.toml provider section (type = protocol, baseUrl =
 * apiBase, `apiKey: ""`). No credentials land on disk: the Okta access token
 * is injected per-request into EVERY generated provider through the engine's
 * in-memory config layer (`KimiHarness.setMemoryConfig`, see token-store.ts).
 *
 * Ownership follows `applyManagedKimiCodeConfig` (packages/oauth): provider
 * sections and model aliases whose names carry OUR prefix are replaced
 * wholesale by the current catalog (stale groups removed, user `overrides`
 * sub-objects preserved); everything else in `[models]` / `[providers]` is
 * untouched. Writes go through the harness's atomic section replace.
 */
import type { KimiConfig, KimiHarness, ProviderType } from "@moonshot-ai/kimi-code-sdk";

import type { GatewayConfig } from "./gateway-config";

/** Values accepted as a config.toml provider `type` (ProviderTypeSchema). */
const KNOWN_PROTOCOLS = new Set(["anthropic", "openai", "openai_responses", "kimi", "google-genai", "vertexai"]);

/** Wire protocols valid on a MODEL entry (models.<id>.protocol). */
const MODEL_PROTOCOLS = new Set(["anthropic", "openai", "openai_responses", "google-genai"]);

/** One catalog entry from `{data: [...]}` — the raw gateway shape. */
export interface OktaModelEntry {
  /** Model id sent in the inference request payload. */
  readonly model: string;
  /** Human-facing name (dropdown label); falls back to the id. */
  readonly displayName: string;
  /** Inference protocol; becomes the provider section's `type`. */
  readonly protocol: string;
  /** This model's own inference endpoint (baseUrl of its provider group). */
  readonly apiBase: string;
  /** Window size in tokens when the catalog declares one. */
  readonly contextLength: number | undefined;
}

export interface OktaProvisionResult {
  readonly modelsCount: number;
  readonly defaultModel: string;
  /** Generated provider section names — the engine injection key list. */
  readonly providerNames: readonly string[];
}

export async function fetchOktaModels(gateway: GatewayConfig, accessToken: string): Promise<OktaModelEntry[]> {
  const url = `${gateway.modelsBaseUrl}${gateway.modelsPath}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "api-key": accessToken,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Model list request to ${url} failed: ${describeFetchFailure(error)}`, { cause: error });
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    const message = isRecord(detail) && typeof detail["error"] === "string"
      ? detail["error"]
      : isRecord(detail) && typeof detail["message"] === "string"
        ? detail["message"]
        : "unknown error";
    throw new Error(`Model list request to ${url} failed (HTTP ${response.status}): ${message}`);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload["data"])
      ? payload["data"]
      : [];
  const models: OktaModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = parseModelEntry(raw, url, gateway.protocolAliases);
    if (entry === undefined) continue;
    const key = `${entry.protocol}\n${entry.apiBase}\n${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(entry);
  }
  if (models.length === 0) {
    throw new Error(`No models available from ${url}.`);
  }
  return models;
}

function parseModelEntry(
  raw: unknown,
  url: string,
  protocolAliases: Readonly<Record<string, string>>,
): OktaModelEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const model = nonEmptyString(raw["model"]) ?? nonEmptyString(raw["id"]);
  if (model === undefined) return undefined;
  const protocolLabel = nonEmptyString(raw["provider"]);
  if (protocolLabel === undefined) {
    throw new Error(`A model entry from ${url} ("${model}") is missing "provider" (the inference protocol).`);
  }
  // Label → protocol mapping is deployment knowledge, NEVER guessed here:
  // every mapping comes from gateway.json's protocolAliases. Unknown labels
  // fail loudly so the admin maps them explicitly.
  const protocol = protocolAliases[protocolLabel] ?? protocolLabel;
  if (!KNOWN_PROTOCOLS.has(protocol)) {
    if (protocolAliases[protocolLabel] !== undefined) {
      throw new Error(
        `protocolAliases maps "${protocolLabel}" to "${protocol}", which is not a supported protocol. Supported: ${[...KNOWN_PROTOCOLS].join(", ")}.`,
      );
    }
    throw new Error(
      `Model "${model}" from ${url} declares an unsupported protocol "${protocol}". Supported: ${[...KNOWN_PROTOCOLS].join(", ")}.`,
    );
  }
  const apiBaseRaw = nonEmptyString(raw["apiBase"]);
  if (apiBaseRaw === undefined) {
    throw new Error(`A model entry from ${url} ("${model}") is missing "apiBase" (its inference endpoint).`);
  }
  let apiBase: URL;
  try {
    apiBase = new URL(apiBaseRaw);
  } catch {
    throw new Error(`Model "${model}" from ${url} has an invalid "apiBase" (got "${apiBaseRaw}").`);
  }
  if (apiBase.protocol !== "https:" && apiBase.protocol !== "http:") {
    throw new Error(`Model "${model}" from ${url} has a non-http(s) "apiBase" (got "${apiBaseRaw}").`);
  }
  return {
    model,
    displayName: nonEmptyString(raw["name"]) ?? model,
    protocol,
    apiBase: trimTrailingSlash(apiBaseRaw),
    contextLength: parseContextLength(raw["contextLength"]),
  };
}

function parseContextLength(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Pure section builder: groups the catalog by (protocol, apiBase) into
 * provider sections named `<prefix>-<protocol>` (short, host-free; a second
 * group on the same protocol gets -2, -3, …), writes one alias per model
 * with an explicit `protocol` (the chat preflight demands
 * models.<id>.protocol, so we never rely on the provider.type fallback), and
 * returns the COMPLETE `providers` / `models` / `defaultModel` sections
 * (foreign entries preserved) ready for `replaceConfigSections`. Sections
 * and aliases carrying our prefix but absent from the current catalog are
 * removed (stale groups heal on re-login — including the older long
 * host-suffixed names).
 */
export function applyOktaProviderConfig(
  config: KimiConfig,
  input: {
    readonly gateway: GatewayConfig;
    readonly models: readonly OktaModelEntry[];
  },
): {
  providers: NonNullable<KimiConfig["providers"]>;
  models: NonNullable<KimiConfig["models"]>;
  defaultModel: string;
  providerNames: readonly string[];
} {
  const { gateway } = input;
  if (input.models.length === 0) {
    throw new Error("No models available for the Okta provider.");
  }
  const prefix = `${gateway.providerName}-`;

  // Deterministic grouping: same catalog → same generated names, so
  // re-provisioning is a no-op diff and stale groups heal on re-login.
  const groups = new Map<string, { protocol: string; apiBase: string }>();
  for (const entry of input.models) {
    groups.set(`${entry.protocol}\n${entry.apiBase}`, { protocol: entry.protocol, apiBase: entry.apiBase });
  }
  // Names are taken within THIS provisioning round only: existing sections
  // with our prefix are replaceable (same group reclaims its name), foreign
  // sections cannot collide because generated names always start with the
  // prefix. Distinct groups with the same protocol+host get -2, -3, …
  const taken = new Set<string>();
  const providers: NonNullable<KimiConfig["providers"]> = { ...config.providers };
  const nameByGroup = new Map<string, string>();
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    if (group === undefined) continue;
    const base = `${gateway.providerName}-${group.protocol}`;
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(name);
    nameByGroup.set(key, name);
    providers[name] = {
      // Narrowed by the KNOWN_PROTOCOLS check at parse time.
      type: group.protocol as ProviderType,
      baseUrl: group.apiBase,
      apiKey: "",
    };
  }

  const existingModels: NonNullable<KimiConfig["models"]> = { ...config.models };
  const aliasFor = (providerEntry: string, model: string): string => `${providerEntry}/${model}`;
  const aliasKeys = new Set<string>();
  for (const entry of input.models) {
    const providerEntry = nameByGroup.get(`${entry.protocol}\n${entry.apiBase}`);
    if (providerEntry !== undefined) aliasKeys.add(aliasFor(providerEntry, entry.model));
  }

  // Remove stale aliases and provider sections carrying our prefix (the
  // catalog no longer lists them); keep everything owned by others.
  for (const [key, alias] of Object.entries(existingModels)) {
    if (
      isRecord(alias) &&
      typeof alias["provider"] === "string" &&
      alias["provider"].startsWith(prefix) &&
      !aliasKeys.has(key)
    ) {
      delete existingModels[key];
    }
  }
  for (const name of Object.keys(providers)) {
    if (name.startsWith(prefix) && !taken.has(name)) {
      delete providers[name];
    }
  }
  // Write our aliases; user-added extras (e.g. `overrides`) survive the merge.
  for (const entry of input.models) {
    const providerEntry = nameByGroup.get(`${entry.protocol}\n${entry.apiBase}`);
    if (providerEntry === undefined) continue;
    const key = aliasFor(providerEntry, entry.model);
    const previous = isRecord(existingModels[key]) ? existingModels[key] : {};
    existingModels[key] = {
      ...previous,
      provider: providerEntry,
      model: entry.model,
      maxContextSize: entry.contextLength ?? gateway.defaultContextLength,
      displayName: entry.displayName,
      // The wire protocol lives on the model itself: some resolution paths
      // only consult models.<id>.protocol, so belt-and-braces alongside the
      // provider section's type. Only the four wire protocols are valid at
      // model level (kimi/vertexai stay provider-type-only).
      ...(MODEL_PROTOCOLS.has(entry.protocol) ? { protocol: entry.protocol as "anthropic" } : {}),
    };
  }

  const currentDefault = typeof config.defaultModel === "string" ? config.defaultModel : undefined;
  const currentAlias = currentDefault !== undefined ? existingModels[currentDefault] : undefined;
  const currentIsOurs = isRecord(currentAlias) && typeof currentAlias["provider"] === "string" && currentAlias["provider"].startsWith(prefix);
  const firstAlias = aliasKeys.values().next().value as string;
  const defaultModel = currentDefault !== undefined && !currentIsOurs ? currentDefault : firstAlias;

  return { providers, models: existingModels, defaultModel, providerNames: [...taken] };
}

export async function provisionOktaModels(input: {
  readonly harness: KimiHarness;
  readonly gateway: GatewayConfig;
  readonly accessToken: string;
}): Promise<OktaProvisionResult> {
  const { harness, gateway, accessToken } = input;
  if (!harness.supportsAtomicSectionReplace()) {
    throw new Error(
      "Okta SSO requires the default (v2) engine. Disable the 'kimi.useAgentCoreV1' setting, reload the window, and sign in again.",
    );
  }
  const models = await fetchOktaModels(gateway, accessToken);
  const current = await harness.getConfig({ reload: true });
  const sections = applyOktaProviderConfig(current, {
    gateway,
    models,
  });
  await harness.replaceConfigSections({
    providers: sections.providers,
    models: sections.models,
    defaultModel: sections.defaultModel,
  });
  return { modelsCount: models.length, defaultModel: sections.defaultModel, providerNames: sections.providerNames };
}

/** Removes every generated provider section (logout). */
export async function removeOktaProviders(harness: KimiHarness, providerNames: readonly string[]): Promise<void> {
  for (const name of providerNames) {
    await harness.removeProvider(name);
  }
  await harness.getConfig({ reload: true });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages: string[] = [];
  let current: Error | undefined = error;
  while (current !== undefined) {
    messages.push(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return [...new Set(messages)].join(": ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
