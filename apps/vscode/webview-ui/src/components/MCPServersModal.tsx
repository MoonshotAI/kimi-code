import { useState, useEffect } from "react";
import { IconX, IconServer, IconWorld, IconTerminal2, IconInfoCircle } from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores";
import { bridge } from "@/services";
import { cn } from "@/lib/utils";
import type { MCPServerConfig } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";

function ServerItem({ server }: { server: MCPServerConfig }) {
  const isHttp = server.transport === "http";
  const info = isHttp ? server.url : [server.command, ...(server.args || [])].join(" ");

  return (
    <div className="rounded-md border border-border/60 bg-card/30 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <div className={cn("size-6 rounded flex items-center justify-center text-xs", isHttp ? "bg-blue-500/10 text-blue-500" : "bg-emerald-500/10 text-emerald-500")}>
          {isHttp ? <IconWorld className="size-3.5" /> : <IconTerminal2 className="size-3.5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{server.name}</span>
            {server.auth === "oauth" && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">OAuth</span>}
          </div>
          <p className="text-[10px] text-muted-foreground truncate font-mono">{info}</p>
        </div>
      </div>
    </div>
  );
}

export function MCPServersModal() {
  const { mcpServers, mcpModalOpen, setMCPServers, setMCPModalOpen } = useSettingsStore(
    useShallow((state) => ({
      mcpServers: state.mcpServers,
      mcpModalOpen: state.mcpModalOpen,
      setMCPServers: state.setMCPServers,
      setMCPModalOpen: state.setMCPModalOpen,
    })),
  );

  useEffect(() => {
    if (mcpModalOpen) bridge.getMCPServers().then(setMCPServers);
  }, [mcpModalOpen, setMCPServers]);

  if (!mcpModalOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <IconServer className="size-4 text-blue-500" />
          <h2 className="text-xs font-medium">MCP Servers</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" onClick={() => setMCPModalOpen(false)}>
            <IconX className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-3 py-3 space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <IconInfoCircle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">MCP servers are managed in the Kimi Code CLI</p>
              <p className="text-[11px] opacity-90">
                Run <code className="px-1 py-0.5 rounded bg-amber-500/10 font-mono">kimi</code> in your terminal and use{" "}
                <code className="px-1 py-0.5 rounded bg-amber-500/10 font-mono">/mcp-config</code> to add, edit, or test servers. Changes take effect on the next
                conversation.
              </p>
            </div>
          </div>

          {mcpServers.length > 0 && (
            <div className="space-y-1.5">
              {mcpServers.map((server) => (
                <ServerItem key={server.name} server={server} />
              ))}
            </div>
          )}

          {mcpServers.length === 0 && (
            <div className="py-6 text-center">
              <IconServer className="size-6 mx-auto text-muted-foreground/30 mb-1" />
              <p className="text-xs text-muted-foreground">No MCP servers configured in the workspace view</p>
              <p className="text-[10px] text-muted-foreground mt-1">Use the CLI /mcp-config to manage servers.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
