/**
 * Gateway configuration, loaded from `<homeDir>/gateway.json` (default
 * `~/.kimi-code/gateway.json`). The gateway is YOUR OWN API — Okta only
 * issues the identity token. This file describes the MODEL CATALOG ONLY
 * (where to fetch the list): each catalog entry carries its own inference
 * endpoint (apiBase) and protocol, so no inference URL lives here. Kept
 * separate from okta.json on purpose: the IdP and the gateway are
 * administered by different people and change at different times.
 *
 * Example file:
 * {
 *   "modelsBaseUrl": "https://api.example.internal",
 *   "modelsPath": "/models",
 *   "providerName": "okta",
 *   "defaultContextLength": 128000,
 *   "protocolAliases": { "openai": "openai_responses", "openrouter": "openai_responses" }
 * }
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface GatewayConfig {
  /** Base URL of the model CATALOG (GET {modelsBaseUrl}{modelsPath}). */
  readonly modelsBaseUrl: string;
  readonly modelsPath: string;
  /** Prefix for the generated config.toml provider section names. */
  readonly providerName: string;
  /** Fallback window size when a catalog entry has no contextLength. */
  readonly defaultContextLength: number;
  /**
   * Catalog label → actual inference protocol, for gateways whose "provider"
   * labels name the vendor rather than the wire protocol (e.g. everything is
   * labeled "openai" or "openrouter" but served over the Responses API).
   * The ONLY mapping source — nothing is guessed in code. Values are
   * validated against the supported protocols when the catalog is parsed.
   */
  readonly protocolAliases: Readonly<Record<string, string>>;
}

export const GATEWAY_CONFIG_FILENAME = "gateway.json";

const DEFAULT_MODELS_PATH = "/models";
export const DEFAULT_GATEWAY_PROVIDER_NAME = "okta";
const DEFAULT_CONTEXT_LENGTH = 128000;
const EMPTY_PROTOCOL_ALIASES: Readonly<Record<string, string>> = {};

interface GatewayCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly config: GatewayConfig | undefined;
}

const gatewayCache = new Map<string, GatewayCacheEntry>();

export function gatewayConfigPath(homeDir: string): string {
  return join(homeDir, GATEWAY_CONFIG_FILENAME);
}

export function clearGatewayConfigCache(): void {
  gatewayCache.clear();
}

export function loadGatewayConfig(homeDir: string): GatewayConfig | undefined {
  const path = gatewayConfigPath(homeDir);
  let mtimeMs = 0;
  let size = -1;
  try {
    const stats = statSync(path);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    gatewayCache.delete(homeDir);
    return undefined;
  }
  const cached = gatewayCache.get(homeDir);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.config;
  }
  const config = parseGatewayConfig(path);
  gatewayCache.set(homeDir, { mtimeMs, size, config });
  return config;
}

function parseGatewayConfig(path: string): GatewayConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid gateway config (${path}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid gateway config (${path}): expected a JSON object.`);
  }
  const modelsBaseUrl = requireHttpUrl(raw, "modelsBaseUrl", path);
  return {
    modelsBaseUrl,
    protocolAliases: parseProtocolAliases(raw, path),
    modelsPath:
      typeof raw["modelsPath"] === "string" && raw["modelsPath"].startsWith("/")
        ? raw["modelsPath"]
        : DEFAULT_MODELS_PATH,
    providerName:
      typeof raw["providerName"] === "string" && raw["providerName"].length > 0
        ? raw["providerName"]
        : DEFAULT_GATEWAY_PROVIDER_NAME,
    defaultContextLength:
      typeof raw["defaultContextLength"] === "number" && Number.isInteger(raw["defaultContextLength"]) && raw["defaultContextLength"] > 0
        ? raw["defaultContextLength"]
        : DEFAULT_CONTEXT_LENGTH,
  };
}

function parseProtocolAliases(raw: Record<string, unknown>, path: string): Readonly<Record<string, string>> {
  const value = raw["protocolAliases"];
  if (value === undefined) return EMPTY_PROTOCOL_ALIASES;
  if (!isRecord(value)) {
    throw new Error(`Invalid gateway config (${path}): "protocolAliases" must be an object of label → protocol.`);
  }
  const aliases: Record<string, string> = {};
  for (const [label, protocol] of Object.entries(value)) {
    if (typeof protocol !== "string" || protocol.trim().length === 0) {
      throw new Error(`Invalid gateway config (${path}): "protocolAliases.${label}" must be a non-empty protocol name.`);
    }
    aliases[label] = protocol.trim();
  }
  return aliases;
}

function requireNonEmptyString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid gateway config (${path}): "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function requireHttpUrl(record: Record<string, unknown>, field: string, path: string): string {
  const value = requireNonEmptyString(record, field, path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid gateway config (${path}): "${field}" must be a URL (got "${value}").`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Invalid gateway config (${path}): "${field}" must use http(s) (got "${value}"). Local http is allowed for development gateways.`,
    );
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
