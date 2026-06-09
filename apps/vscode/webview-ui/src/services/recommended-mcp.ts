import type { MCPServerConfig } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";

export interface RecommendedMCPServer {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  github?: string;
}

export const RECOMMENDED_MCP_SERVERS: RecommendedMCPServer[] = [
  {
    id: "playwright",
    name: "Playwright",
    description: "Browser automation and web scraping with headless Chrome",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    github: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date documentation for any library directly in your prompt",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"],
    github: "https://github.com/upstash/context7",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repository management, file operations, and GitHub API integration",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github@latest"],
    github: "https://github.com/modelcontextprotocol/servers",
  },
];

export function recommendedToConfig(server: RecommendedMCPServer): MCPServerConfig {
  return {
    name: server.id,
    transport: "stdio",
    command: server.command,
    args: server.args,
  };
}
