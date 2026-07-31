#!/usr/bin/env node
// Vercel MCP plugin for Kimi Code
// Provides tools to interact with Vercel projects and deployments

import { readFile } from 'node:fs/promises';
import readline from 'node:readline';

const VERSION = '0.1.0';
const PROTOCOL_VERSION = '2025-06-18';
const VERCEL_API_BASE = 'https://api.vercel.com';

function getToken() {
  const token = process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN;
  if (!token) {
    throw new Error(
      'VERCEL_TOKEN environment variable is required. Set it with: export VERCEL_TOKEN=<your-token>'
    );
  }
  return token;
}

async function vercelFetch(path, options = {}) {
  const token = getToken();
  const url = `${VERCEL_API_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vercel API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

const TOOLS = [
  {
    name: 'vercel_list_projects',
    description: 'List all Vercel projects for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of projects to return (default: 20, max: 100).',
          default: 20,
        },
      },
    },
  },
  {
    name: 'vercel_get_project',
    description: 'Get details of a specific Vercel project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name or ID of the Vercel project.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'vercel_list_deployments',
    description: 'List deployments for a Vercel project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The ID or name of the project to list deployments for.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of deployments to return (default: 20).',
          default: 20,
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'vercel_get_deployment',
    description: 'Get details of a specific deployment by its ID or URL.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The deployment ID or URL (e.g., "dpl_xxx" or "my-project-xxx.vercel.app").',
        },
      },
      required: ['id'],
    },
  },
];

const HANDLERS = {
  vercel_list_projects: async (args) => {
    const limit = Math.min(args.limit || 20, 100);
    const data = await vercelFetch(`/v9/projects?limit=${limit}`);
    return {
      projects: data.projects.map((p) => ({
        id: p.id,
        name: p.name,
        framework: p.framework,
        latestDeployment: p.latestDeployments?.[0]
          ? {
              id: p.latestDeployments[0].uid,
              url: p.latestDeployments[0].url,
              state: p.latestDeployments[0].state,
              createdAt: p.latestDeployments[0].createdAt,
            }
          : null,
        createdAt: p.createdAt,
      })),
      count: data.projects.length,
      total: data.pagination?.count ?? data.projects.length,
    };
  },

  vercel_get_project: async (args) => {
    const data = await vercelFetch(`/v9/projects/${encodeURIComponent(args.name)}`);
    return {
      id: data.id,
      name: data.name,
      framework: data.framework,
      rootDirectory: data.rootDirectory,
      latestDeployment: data.latestDeployments?.[0]
        ? {
            id: data.latestDeployments[0].uid,
            url: data.latestDeployments[0].url,
            state: data.latestDeployments[0].state,
            createdAt: data.latestDeployments[0].createdAt,
          }
        : null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  },

  vercel_list_deployments: async (args) => {
    const limit = Math.min(args.limit || 20, 100);
    const data = await vercelFetch(
      `/v6/deployments?projectId=${encodeURIComponent(args.projectId)}&limit=${limit}`
    );
    return {
      deployments: data.deployments.map((d) => ({
        id: d.uid,
        url: d.url,
        state: d.state,
        createdAt: d.createdAt,
        creator: d.creator?.username || d.creator?.email,
        target: d.target,
      })),
      count: data.deployments.length,
    };
  },

  vercel_get_deployment: async (args) => {
    const id = args.id;
    let path;
    if (id.includes('.vercel.app') || id.startsWith('http')) {
      // URL-based lookup
      const url = id.startsWith('http') ? id : `https://${id}`;
      path = `/v13/deployments/get?url=${encodeURIComponent(url)}`;
    } else {
      path = `/v13/deployments/${encodeURIComponent(id)}`;
    }
    const data = await vercelFetch(path);
    return {
      id: data.id,
      url: data.url,
      state: data.readyState || data.state,
      createdAt: data.createdAt,
      creator: data.creator?.username || data.creator?.email,
      target: data.target,
      project: data.name,
      inspectorUrl: data.inspectorUrl,
    };
  },
};

// MCP stdio transport
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

const state = {
  initialized: false,
  requestId: null,
};

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.jsonrpc !== '2.0') return;

  if (message.method === 'initialize') {
    state.initialized = true;
    state.requestId = message.id;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'kimi-vercel',
          version: VERSION,
        },
      },
    });
    return;
  }

  if (message.method === 'notifications/initialized') {
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    const handler = HANDLERS[name];

    if (!handler) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
      return;
    }

    try {
      const result = await handler(args || {}, process.cwd());
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: error.message }, null, 2),
            },
          ],
          isError: true,
        },
      });
    }
    return;
  }
});
