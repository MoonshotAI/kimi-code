/**
 *   GET  /v1/tools                       query: { session_id? }
 *   GET  /v1/mcp/servers
 *   POST /v1/mcp/servers/{mcp_server_id}:restart
 */

import { z } from 'zod';

import { mcpServerSchema, toolDescriptorSchema } from './tool';

export const listToolsQuerySchema = z.object({
  session_id: z.string().min(1).optional(),
});
export type ListToolsQuery = z.infer<typeof listToolsQuerySchema>;

export const listToolsResponseSchema = z.object({
  tools: z.array(toolDescriptorSchema),
});
export type ListToolsResponse = z.infer<typeof listToolsResponseSchema>;

export const listMcpServersResponseSchema = z.object({
  servers: z.array(mcpServerSchema),
});
export type ListMcpServersResponse = z.infer<typeof listMcpServersResponseSchema>;

export const restartMcpServerResultSchema = z.object({
  restarting: z.literal(true),
});
export type RestartMcpServerResult = z.infer<typeof restartMcpServerResultSchema>;
