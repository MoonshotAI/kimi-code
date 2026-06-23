#!/usr/bin/env node
// OpenSpec MCP plugin for Kimi Code
// Provides tools to interact with OpenSpec projects (fission.ai/openspec)

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import readline from 'node:readline';

const VERSION = '0.1.0';
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'openspec_status',
    description: 'Check if the current workspace is an OpenSpec project.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'openspec_list_changes',
    description: 'List all changes (proposals) in the openspec/changes directory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'openspec_list_specs',
    description: 'List all specs in the openspec/specs directory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'openspec_read_change',
    description: 'Read the content of a specific change file (proposal.md, design.md, or tasks.md).',
    inputSchema: {
      type: 'object',
      properties: {
        change_id: {
          type: 'string',
          description: 'The change directory name (e.g., "auth-refactor").',
        },
        filename: {
          type: 'string',
          enum: ['proposal.md', 'design.md', 'tasks.md'],
          description: 'Which file to read within the change directory.',
        },
      },
      required: ['change_id', 'filename'],
    },
  },
  {
    name: 'openspec_read_spec',
    description: 'Read the content of a specific spec file.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: {
          type: 'string',
          description: 'The spec directory or file name.',
        },
      },
      required: ['spec_id'],
    },
  },
];

const HANDLERS = {
  openspec_status: async (_args, cwd) => {
    const configPath = join(cwd, 'openspec', 'config.yaml');
    try {
      await stat(configPath);
      return {
        isOpenSpec: true,
        configPath: 'openspec/config.yaml',
        message: 'This workspace is an OpenSpec project.',
      };
    } catch {
      return {
        isOpenSpec: false,
        message: 'No openspec/config.yaml found in workspace.',
      };
    }
  },

  openspec_list_changes: async (_args, cwd) => {
    const changesDir = join(cwd, 'openspec', 'changes');
    try {
      const entries = await readdir(changesDir, { withFileTypes: true });
      const changes = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const changePath = join(changesDir, entry.name);
          let status = 'unknown';
          try {
            const proposal = await readFile(join(changePath, 'proposal.md'), 'utf-8');
            status = extractStatus(proposal);
          } catch {}
          changes.push({ id: entry.name, status });
        }
      }
      return { changes };
    } catch {
      return { changes: [], message: 'No openspec/changes directory found.' };
    }
  },

  openspec_list_specs: async (_args, cwd) => {
    const specsDir = join(cwd, 'openspec', 'specs');
    try {
      const entries = await readdir(specsDir, { withFileTypes: true });
      const specs = [];
      for (const entry of entries) {
        specs.push({ name: entry.name, isDirectory: entry.isDirectory() });
      }
      return { specs };
    } catch {
      return { specs: [], message: 'No openspec/specs directory found.' };
    }
  },

  openspec_read_change: async (args, cwd) => {
    const { change_id, filename } = args;
    const filePath = join(cwd, 'openspec', 'changes', change_id, filename);
    try {
      const content = await readFile(filePath, 'utf-8');
      return { content, path: `openspec/changes/${change_id}/${filename}` };
    } catch (err) {
      return {
        error: true,
        message: `Cannot read ${filename} for change "${change_id}": ${err.message}`,
      };
    }
  },

  openspec_read_spec: async (args, cwd) => {
    const { spec_id } = args;
    // Try as a directory first, then as a file
    const dirPath = join(cwd, 'openspec', 'specs', spec_id);
    const filePath = join(cwd, 'openspec', 'specs', spec_id);
    try {
      const s = await stat(dirPath);
      if (s.isDirectory()) {
        const entries = await readdir(dirPath);
        return { type: 'directory', entries, path: `openspec/specs/${spec_id}` };
      }
    } catch {}
    try {
      const content = await readFile(filePath, 'utf-8');
      return { type: 'file', content, path: `openspec/specs/${spec_id}` };
    } catch (err) {
      return {
        error: true,
        message: `Cannot read spec "${spec_id}": ${err.message}`,
      };
    }
  },
};

function extractStatus(proposal) {
  const lines = proposal.split('\n');
  for (const line of lines) {
    const match = line.match(/^status:\s*(\w+)/i);
    if (match) return match[1].toLowerCase();
  }
  return 'unknown';
}

// --- MCP stdio transport ---

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const method = msg.method;

  if (method === 'initialize') {
    initialized = true;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, sampling: {} },
        serverInfo: { name: 'openspec-mcp', version: VERSION },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    const handler = HANDLERS[name];
    if (!handler) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Tool not found: ${name}` },
      });
      return;
    }
    try {
      const cwd = msg.params._meta?.cwd || process.cwd();
      const result = await handler(args || {}, cwd);
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message || 'Internal error' },
      });
    }
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
