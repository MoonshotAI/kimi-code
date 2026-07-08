#!/usr/bin/env node
// Stdio MCP server for kimi-openspec.
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout per the MCP "stdio"
// transport. Exposes OpenSpec CLI tools so Kimi Code can drive spec-driven
// development workflows.
//
// Business logic is kept self-contained so the plugin can run from a zipped
// marketplace install without workspace package dependencies.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const OPENSPEC_CMD = 'npx --yes @fission-ai/openspec';

const execAsync = promisify(exec);

// ─── Cache ───────────────────────────────────────────────────────────

function buildCache(projectPath) {
  return {
    projectPath,
    entries: new Map(),
    lastRefresh: 0,
  };
}

async function refreshCache(cache) {
  const cwd = cache.projectPath;
  const changesDir = path.join(cwd, 'openspec', 'changes');
  const specsDir = path.join(cwd, 'openspec', 'specs');

  cache.entries.clear();

  // Scan changes
  try {
    const changes = await readDirEntries(changesDir);
    for (const name of changes) {
      const changePath = path.join(changesDir, name);
      const files = await listMarkdownFiles(changePath);
      cache.entries.set(`change:${name}`, { name, type: 'change', files });
    }
  } catch {
    // Directory may not exist yet
  }

  // Scan specs
  try {
    const specs = await readDirEntries(specsDir);
    for (const name of specs) {
      const specPath = path.join(specsDir, name);
      const files = await listMarkdownFiles(specPath);
      cache.entries.set(`spec:${name}`, { name, type: 'spec', files });
    }
  } catch {
    // Directory may not exist yet
  }

  cache.lastRefresh = Date.now();
}

async function readDirEntries(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((d) => d.isDirectory()).map((d) => d.name);
}

async function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((d) => !d.isDirectory() && d.name.endsWith('.md')).map((d) => d.name);
}

function lookupEntry(cache, name, type) {
  if (type) {
    return cache.entries.get(`${type}:${name}`) ?? null;
  }
  // Prefer changes over specs when type is omitted
  return cache.entries.get(`change:${name}`) ?? cache.entries.get(`spec:${name}`) ?? null;
}

async function readSpecFile(cache, cwd, name, fileType, type) {
  const entry = lookupEntry(cache, name, type);
  if (!entry) return null;
  const filePath = path.join(cwd, 'openspec', entry.type === 'change' ? 'changes' : 'specs', name, fileType);
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

// ─── Tools ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'openspec_init',
    description: 'Initialize OpenSpec in the current project. Creates openspec/ directory with configuration and instruction files.',
    inputSchema: {
      type: 'object',
      properties: {
        tools: {
          type: 'string',
          description: 'AI tools to configure non-interactively. Use "all", "none", or a comma-separated list (e.g. "claude,cursor,codex"). Defaults to "claude".',
          default: 'claude',
        },
        force: {
          type: 'boolean',
          description: 'Auto-cleanup legacy files without prompting',
        },
      },
      required: [],
    },
  },
  {
    name: 'openspec_new_change',
    description: 'Create a new change directory with proposal, design, tasks, and spec scaffolding.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the change (kebab-case recommended, e.g. "add-dark-mode")',
        },
        description: {
          type: 'string',
          description: 'Description to add to README.md',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'openspec_list',
    description: 'List all OpenSpec changes or specs. Returns a JSON array.',
    inputSchema: {
      type: 'object',
      properties: {
        specs: {
          type: 'boolean',
          description: 'List specs instead of changes',
        },
      },
      required: [],
    },
  },
  {
    name: 'openspec_show',
    description: 'Show details of a specific change or spec.',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'Name of the item to show',
        },
        type: {
          type: 'string',
          description: 'Item type: "change" or "spec"',
          enum: ['change', 'spec'],
        },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'openspec_status',
    description: 'Display artifact completion status for a change.',
    inputSchema: {
      type: 'object',
      properties: {
        changeName: {
          type: 'string',
          description: 'Change name to show status for',
        },
      },
      required: ['changeName'],
    },
  },
  {
    name: 'openspec_validate',
    description: 'Validate a change proposal or spec. Checks formatting and completeness.',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'Name of the change to validate (optional)',
        },
        all: {
          type: 'boolean',
          description: 'Validate all changes and specs',
        },
        strict: {
          type: 'boolean',
          description: 'Enable strict validation mode',
        },
      },
      required: [],
    },
  },
  {
    name: 'openspec_archive',
    description: 'Archive a completed change and merge its spec updates back into the main specs directory.',
    inputSchema: {
      type: 'object',
      properties: {
        changeName: {
          type: 'string',
          description: 'Name of the change to archive',
        },
        skipSpecs: {
          type: 'boolean',
          description: 'Skip spec updates during archive',
        },
      },
      required: ['changeName'],
    },
  },
  {
    name: 'openspec_update',
    description: 'Update OpenSpec instruction files to the latest version.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'openspec_instructions',
    description: 'Output enriched instructions for an artifact or apply phase.',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: {
          type: 'string',
          description: 'Artifact name (e.g. "design.md", "tasks.md") or "apply"',
        },
        changeName: {
          type: 'string',
          description: 'Change name',
        },
      },
      required: ['artifact'],
    },
  },
  {
    name: 'openspec_read_file',
    description: 'Read any OpenSpec artifact directly by file type. Much faster than show — use this when you need file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Change or spec name (e.g. "add-dark-mode")',
        },
        fileType: {
          type: 'string',
          description: 'File to read',
          enum: ['proposal.md', 'design.md', 'tasks.md', 'spec.md', 'review.md', 'plan.md', '.openspec.yaml'],
        },
        type: {
          type: 'string',
          description: 'Item type to disambiguate if a change and spec share the same name. If omitted, prefers changes.',
          enum: ['change', 'spec'],
        },
      },
      required: ['name', 'fileType'],
    },
  },
  {
    name: 'openspec_refresh_cache',
    description: 'Force refresh the cached directory listing. Use if changes were made outside OpenSpec tools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─── Prompts ─────────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: 'openspec_kickoff',
    description: 'Initialize an AI coding session using Fission-AI OpenSpec best practices for spec-driven development.',
  },
];

// ─── Handlers ────────────────────────────────────────────────────────

async function handleRequest(message, cache) {
  const { method, id, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'kimi-openspec', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return runTool(params, cache);
    case 'prompts/list':
      return { prompts: PROMPTS };
    case 'prompts/get':
      return getPrompt(params);
    default:
      throw jsonRpcError(-32601, `Method not found: ${method}`, { id });
  }
}

function getPrompt(params) {
  const name = params?.name;
  if (name !== 'openspec_kickoff') {
    throw jsonRpcError(-32602, `Prompt not found: ${name}`);
  }
  return {
    description: 'Initialize an AI coding session using Fission-AI OpenSpec best practices for spec-driven development.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `You are an expert AI development assistant operating within a codebase managed by the Fission-AI OpenSpec framework.
Your workflow MUST be strictly spec-driven. Never write code until the specification is completely validated and active.

Follow this workflow exactly:
1. When asked to implement a feature, FIRST check if a change exists by using openspec tools (like \`openspec_status\` or \`openspec_list\`).
2. If there are no open specs for this feature, create one with \`openspec_new_change\`.
3. If an active change exists, use tools to read and validate the active specification.
4. If validation fails, DO NOT PROCEED TO CODE. Fix the spec first.
5. Once the design is validated and error-free, proceed to implement the feature by tackling the tasks sequentially.
6. Always communicate your plan clearly to the user.

Available OpenSpec tools:
- openspec_init: Initialize OpenSpec in the project
- openspec_new_change: Create a new change proposal
- openspec_list: List all changes/specs
- openspec_show: Show a change or spec details
- openspec_status: Check completion status of a change
- openspec_validate: Validate a change or spec
- openspec_archive: Archive a completed change
- openspec_read_file: Read any artifact file directly`,
        },
      },
    ],
  };
}

async function runTool(params, cache) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  const runOpenSpec = async (callArgs) => {
    const cmd = `${OPENSPEC_CMD} ${callArgs.join(' ')}`;
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: cache.projectPath });
      return { success: true, stdout, stderr, message: `Ran: ${cmd}` };
    } catch (error) {
      return {
        success: false,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        message: `Command failed: ${error.message}`,
      };
    }
  };

  switch (name) {
    case 'openspec_init': {
      const tools = typeof args.tools === 'string' && args.tools.length > 0 ? args.tools : 'claude';
      const cmdArgs = ['init', '--tools', `"${tools}"`];
      if (args.force) cmdArgs.push('--force');
      const res = await runOpenSpec(cmdArgs);
      await refreshCache(cache);
      return formatResult(res);
    }

    case 'openspec_new_change': {
      const cmdArgs = ['new', 'change', `"${args.name}"`];
      if (args.description) cmdArgs.push('--description', `"${args.description}"`);
      const res = await runOpenSpec(cmdArgs);
      await refreshCache(cache);
      return formatResult(res);
    }

    case 'openspec_list': {
      const typeFilter = args.specs ? 'spec' : 'change';
      const items = Array.from(cache.entries.values())
        .filter((e) => e.type === typeFilter)
        .map((e) => ({ name: e.name, type: e.type, files: e.files }));

      const output = JSON.stringify({ [args.specs ? 'specs' : 'changes']: items }, null, 2);
      return {
        content: [
          {
            type: 'text',
            text: items.length === 0
              ? `No ${typeFilter}s found in openspec/. Run openspec_init if the project is not initialized yet.`
              : output,
          },
        ],
      };
    }

    case 'openspec_show': {
      const entry = lookupEntry(cache, args.itemName, args.type);
      if (!entry) {
        const available = Array.from(cache.entries.values())
          .filter((e) => !args.type || e.type === args.type)
          .map((e) => `${e.type}:${e.name}`);
        return {
          content: [
            {
              type: 'text',
              text: `No ${args.type ?? 'change or spec'} named '${args.itemName}' found. Available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
            },
          ],
          isError: true,
        };
      }
      const cmdArgs = ['show', `"${args.itemName}"`];
      if (args.type) cmdArgs.push('--type', args.type);
      cmdArgs.push('--json');
      const res = await runOpenSpec(cmdArgs);
      return formatResult(res);
    }

    case 'openspec_status': {
      if (!args.changeName) {
        const changes = Array.from(cache.entries.values())
          .filter((e) => e.type === 'change')
          .map((e) => e.name);
        return {
          content: [
            {
              type: 'text',
              text: `openspec_status requires 'changeName'. Available changes: ${changes.length > 0 ? changes.join(', ') : '(none)'}`,
            },
          ],
          isError: true,
        };
      }
      const cmdArgs = ['status', '--change', `"${args.changeName}"`, '--json'];
      const res = await runOpenSpec(cmdArgs);
      return formatResult(res);
    }

    case 'openspec_validate': {
      const cmdArgs = ['validate'];
      if (args.itemName) cmdArgs.push(`"${args.itemName}"`);
      if (args.all) cmdArgs.push('--all');
      if (args.strict) cmdArgs.push('--strict');
      cmdArgs.push('--json');
      const res = await runOpenSpec(cmdArgs);
      return formatResult(res);
    }

    case 'openspec_archive': {
      const cmdArgs = ['archive', `"${args.changeName}"`, '--yes'];
      if (args.skipSpecs) cmdArgs.push('--skip-specs');
      const res = await runOpenSpec(cmdArgs);
      await refreshCache(cache);
      return formatResult(res);
    }

    case 'openspec_update': {
      const res = await runOpenSpec(['update']);
      await refreshCache(cache);
      return formatResult(res);
    }

    case 'openspec_instructions': {
      const cmdArgs = ['instructions', `"${args.artifact}"`];
      if (args.changeName) cmdArgs.push('--change', `"${args.changeName}"`);
      cmdArgs.push('--json');
      const res = await runOpenSpec(cmdArgs);
      return formatResult(res);
    }

    case 'openspec_read_file': {
      const entry = lookupEntry(cache, args.name, args.type);
      if (!entry) {
        return {
          content: [
            {
              type: 'text',
              text: `No change or spec named '${args.name}' found. Run openspec_list to see available items.`,
            },
          ],
          isError: true,
        };
      }
      const content = await readSpecFile(cache, cache.projectPath, args.name, args.fileType, args.type);
      if (content === null) {
        return {
          content: [
            {
              type: 'text',
              text: `File '${args.fileType}' does not exist for '${args.name}'. Available files: ${entry.files.join(', ')}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `--- ${args.fileType} from ${entry.type}:${args.name} ---\n\n${content}`,
          },
        ],
      };
    }

    case 'openspec_refresh_cache': {
      await refreshCache(cache);
      return {
        content: [
          {
            type: 'text',
            text: 'Cache refreshed successfully.',
          },
        ],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
        isError: true,
      };
  }
}

function formatResult(res) {
  const parts = [];
  if (res.message) parts.push(res.message);
  if (res.stdout) parts.push(`Output:\n${res.stdout}`);
  if (res.stderr) parts.push(`Error Output:\n${res.stderr}`);

  return {
    content: [
      {
        type: 'text',
        text: parts.join('\n\n'),
      },
    ],
    isError: !res.success,
  };
}

// ─── JSON-RPC Transport ──────────────────────────────────────────────

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

async function dispatch(message, cache) {
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
    const result = await handleRequest(message, cache);
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

async function start() {
  const args = process.argv.slice(2);
  const projectPath = args[0] || process.cwd();
  const resolvedPath = path.resolve(projectPath);

  console.error(`[kimi-openspec] Starting for project: ${resolvedPath}`);

  const cache = buildCache(resolvedPath);
  await refreshCache(cache);

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
    void dispatch(message, cache);
  });
  rl.on('close', () => {
    process.exit(0);
  });
}

void start();
