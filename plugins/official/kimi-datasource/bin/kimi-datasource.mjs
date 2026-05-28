#!/usr/bin/env node
// Stdio MCP server for kimi-datasource.
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout per the MCP "stdio"
// transport. Implements the minimal surface the Kimi Code host calls:
//   - initialize
//   - notifications/initialized
//   - tools/list
//   - tools/call
//   - ping
//
// Business logic (API call, credentials, headers) is unchanged from the
// previous one-shot CLI; only the transport changed.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, homedir, hostname, release, type } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const VERSION = '3.0.0';
const API_URL = process.env.KIMI_DATASOURCE_API_URL ?? 'https://api.kimi.com/coding/v1/tools';
const REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2025-06-18';
const VALID_STOCK_QUERY_TYPES = new Set([
  'realtime_price',
  'realtime_tech',
  'open_summary',
  'close_summary',
]);

const TOOLS = [
  {
    name: 'query_stock',
    description:
      'Query realtime stock price, realtime technical indicators, open summaries, or close summaries for up to 3 tickers.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: {
          type: 'string',
          description: 'Ticker code list separated by commas, for example 600519.SH or 0700.HK.',
        },
        type: {
          type: 'string',
          enum: ['realtime_price', 'realtime_tech', 'open_summary', 'close_summary'],
          description: 'Realtime stock query type.',
        },
        time: {
          type: 'string',
          description: 'Optional time parameter for supported realtime endpoints.',
        },
        file_path: {
          type: 'string',
          description: 'Optional CSV output path. When omitted, the tool chooses a temporary path.',
        },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_data_source_desc',
    description:
      'Get the current API documentation for one Kimi data source before calling a specific API.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: [
            'stock_finance_data',
            'yahoo_finance',
            'world_bank_open_data',
            'tianyancha',
            'arxiv',
            'scholar',
          ],
          description: 'Data source name.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'call_data_source_tool',
    description: 'Call one API from a Kimi data source after reading get_data_source_desc.',
    inputSchema: {
      type: 'object',
      properties: {
        data_source_name: {
          type: 'string',
          description: 'Data source name returned or documented by get_data_source_desc.',
        },
        api_name: {
          type: 'string',
          description: 'API name from the data source description.',
        },
        params: {
          type: 'object',
          description: 'API parameters that match the data source description.',
        },
      },
      required: ['data_source_name', 'api_name', 'params'],
    },
  },
];

const HANDLERS = {
  query_stock: {
    method: 'get_stock_realtime_price',
    buildParams(args) {
      const ticker = requiredString(args, 'ticker');
      const tickerList = ticker
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (tickerList.length === 0) throw new Error('Missing required argument: ticker.');
      if (tickerList.length > 3) {
        throw new Error('ticker accepts at most 3 values separated by commas.');
      }

      const queryType = optionalString(args, 'type') ?? 'realtime_price';
      if (!VALID_STOCK_QUERY_TYPES.has(queryType)) {
        throw new Error(
          `type must be one of ${JSON.stringify([...VALID_STOCK_QUERY_TYPES])}; received: ${queryType}`,
        );
      }

      const params = {
        ticker,
        type: queryType,
        file_path: optionalString(args, 'file_path') ?? defaultStockFilePath(ticker, queryType),
      };
      const time = optionalString(args, 'time');
      if (time !== undefined) params.time = time;
      return params;
    },
    format(text, params) {
      return `${text}\n\nCSV data written to: ${params.file_path}`;
    },
  },
  get_data_source_desc: {
    method: 'get_data_source_desc',
    buildParams(args) {
      return { name: requiredString(args, 'name') };
    },
  },
  call_data_source_tool: {
    method: 'call_data_source_tool',
    buildParams(args) {
      return {
        data_source_name: requiredString(args, 'data_source_name'),
        api_name: requiredString(args, 'api_name'),
        params: requiredObject(args, 'params'),
      };
    },
  },
};

async function handleRequest(message) {
  const { method, id, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'kimi-datasource', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return runTool(params);
    default:
      throw jsonRpcError(-32601, `Method not found: ${method}`, { id });
  }
}

async function runTool(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const handler = HANDLERS[name];
  if (handler === undefined) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
      isError: true,
    };
  }
  try {
    const built = handler.buildParams(args);
    const response = await callKimiTool(handler.method, built);
    const text = extractText(response);
    const formatted = (handler.format?.(text, built) ?? text).trim();
    return { content: [{ type: 'text', text: formatted }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }
}

function resolveKimiHome() {
  const explicit = process.env.KIMI_CODE_HOME?.trim();
  return explicit && explicit.length > 0 ? explicit : path.join(homedir(), '.kimi-code');
}

async function loadAccessToken() {
  const kimiHome = resolveKimiHome();
  const credentialsFile = path.join(kimiHome, 'credentials', 'kimi-code.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(credentialsFile, 'utf8'));
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(
        `Kimi Code credentials file not found: ${credentialsFile}\nRun /login in Kimi Code first.`,
      );
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse Kimi Code credentials file: ${err.message}`);
    }
    throw err;
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid Kimi Code credentials file: ${credentialsFile}`);
  }
  const token = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  if (token.length === 0) {
    throw new Error('Kimi Code credentials do not contain access_token. Run /login again.');
  }
  const expiresAt = typeof parsed.expires_at === 'number' ? parsed.expires_at : 0;
  if (expiresAt > 0 && expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('Kimi Code access_token has expired. Run /login again and retry.');
  }
  return { kimiHome, token };
}

async function callKimiTool(method, params) {
  const { kimiHome, token } = await loadAccessToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: await buildHeaders(kimiHome, token),
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} error: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildHeaders(kimiHome, token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Msh-Tool-Call-Id': randomUUID(),
    'X-Msh-Platform': asciiHeader(process.env.KIMI_MSH_PLATFORM ?? 'kimi-code-cli'),
    'X-Msh-Version': asciiHeader(process.env.KIMI_MSH_VERSION ?? VERSION),
    'X-Msh-Device-Name': asciiHeader(process.env.KIMI_MSH_DEVICE_NAME ?? hostname()),
    'X-Msh-Device-Model': asciiHeader(process.env.KIMI_MSH_DEVICE_MODEL ?? deviceModel()),
    'X-Msh-Os-Version': asciiHeader(process.env.KIMI_MSH_OS_VERSION ?? release()),
    'X-Msh-Device-Id': asciiHeader(process.env.KIMI_MSH_DEVICE_ID ?? (await createDeviceId(kimiHome))),
    'User-Agent': `kimi-datasource/${VERSION}`,
  };
}

async function createDeviceId(kimiHome) {
  const deviceIdPath = path.join(kimiHome, 'device_id');
  try {
    const existing = (await readFile(deviceIdPath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Fall through to create a best-effort local device id.
  }

  const id = randomUUID();
  try {
    await mkdir(kimiHome, { recursive: true, mode: 0o700 });
    await writeFile(deviceIdPath, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Headers can still use the in-memory id if the file cannot be written.
  }
  return id;
}

function deviceModel() {
  const os = type();
  const osVersion = release();
  const osArch = arch();
  if (os === 'Darwin') return `macOS ${osVersion} ${osArch}`;
  if (os === 'Windows_NT') return `Windows ${osVersion} ${osArch}`;
  return `${os} ${osVersion} ${osArch}`.trim();
}

function extractText(response) {
  if (typeof response === 'string') return response;
  if (!isRecord(response)) return String(response);

  if (response.is_success === false) {
    const message = extractUserText(response.error) ?? JSON.stringify(response);
    throw new Error(`Tool API returned an error: ${message}`);
  }

  const text = extractUserText(response.result);
  if (text !== undefined) return text;
  return `Tool API succeeded but did not return user text. Raw response: ${JSON.stringify(response)}`;
}

function extractUserText(value) {
  if (!isRecord(value) || !Array.isArray(value.user)) return undefined;
  const text = value.user
    .filter((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n');
  return text.length > 0 ? text : undefined;
}

function defaultStockFilePath(ticker, queryType) {
  const safeTicker = ticker.replaceAll(',', '_').replaceAll('.', '_');
  return `/tmp/stock_${safeTicker}_${queryType}.csv`;
}

function requiredString(args, field) {
  const value = optionalString(args, field);
  if (value === undefined) throw new Error(`Missing required argument: ${field}.`);
  return value;
}

function optionalString(args, field) {
  if (!isRecord(args)) return undefined;
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredObject(args, field) {
  if (!isRecord(args)) throw new Error(`Missing required argument: ${field}.`);
  const value = args[field];
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(err) {
  return isRecord(err) && err.code === 'ENOENT';
}

function asciiHeader(value, fallback = 'unknown') {
  const cleaned = String(value).replaceAll(/[^ -~]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function jsonRpcError(code, message, data) {
  const err = new Error(message);
  err.jsonRpc = { code, message, data };
  return err;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, error) {
  send({ jsonrpc: '2.0', id, error });
}

async function dispatch(message) {
  if (message?.jsonrpc !== '2.0') return;
  // Notifications carry no id and never expect a response.
  if (message.id === undefined || message.id === null) {
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      return;
    }
    return;
  }
  const id = message.id;
  try {
    const result = await handleRequest(message);
    sendResult(id, result ?? {});
  } catch (err) {
    if (err && typeof err === 'object' && err.jsonRpc !== undefined) {
      sendError(id, err.jsonRpc);
      return;
    }
    sendError(id, {
      code: -32603,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function start() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, {
        code: -32700,
        message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    void dispatch(message);
  });
  rl.on('close', () => {
    process.exit(0);
  });
}

start();
