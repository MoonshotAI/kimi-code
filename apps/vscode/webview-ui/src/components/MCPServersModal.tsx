import { useState, useEffect, useMemo } from "react";
import {
  IconX,
  IconPlus,
  IconTrash,
  IconServer,
  IconKey,
  IconRefresh,
  IconPlugConnected,
  IconLoader2,
  IconWorld,
  IconTerminal2,
  IconBrandGithub,
  IconChevronDown,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSettingsStore } from "@/stores";
import { bridge } from "@/services";
import { RECOMMENDED_MCP_SERVERS, recommendedToConfig, type RecommendedMCPServer } from "@/services/recommended-mcp";
import { cn } from "@/lib/utils";
import { MCP_SECRET_MASK, type MCPServerConfig } from "shared/legacy-sdk";

type TransportType = "stdio" | "http";

interface KeyValueField {
  key: string;
  value: string;
}

interface FormData {
  name: string;
  transport: TransportType;
  url: string;
  command: string;
  args: string[];
  envVars: KeyValueField[];
  headerVars: KeyValueField[];
  bearerTokenEnvVar: string;
  requiresAuth: boolean;
}

function emptyForm(): FormData {
  return {
    name: "",
    transport: "stdio",
    url: "",
    command: "",
    args: [""],
    envVars: [],
    headerVars: [],
    bearerTokenEnvVar: "",
    requiresAuth: false,
  };
}

function serverToForm(s?: MCPServerConfig): FormData {
  if (!s) return emptyForm();
  const isHttp = s.transport === "http";
  return {
    name: s.name,
    transport: isHttp ? "http" : "stdio",
    url: s.url ?? "",
    command: s.command ?? "",
    args: s.args ? [...s.args] : [],
    envVars: s.env ? Object.entries(s.env).map(([key, value]) => ({ key, value })) : [],
    headerVars: s.headers ? Object.entries(s.headers).map(([key, value]) => ({ key, value })) : [],
    bearerTokenEnvVar: s.bearerTokenEnvVar ?? "",
    requiresAuth: s.auth === "oauth",
  };
}

function formToConfig(f: FormData): MCPServerConfig {
  const env = f.envVars.reduce((acc, { key, value }) => (key.trim() ? { ...acc, [key.trim()]: value } : acc), {} as Record<string, string>);
  const headers = f.headerVars.reduce((acc, { key, value }) => (key.trim() ? { ...acc, [key.trim()]: value } : acc), {} as Record<string, string>);
  if (f.transport === "http") {
    const bearerTokenEnvVar = f.bearerTokenEnvVar.trim();
    return {
      name: f.name.trim(),
      transport: "http",
      url: f.url.trim(),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      bearerTokenEnvVar: bearerTokenEnvVar || undefined,
      auth: f.requiresAuth ? "oauth" : undefined,
    };
  }
  const args = f.args.filter((arg) => arg.length > 0);
  return {
    name: f.name.trim(),
    transport: "stdio",
    command: f.command.trim(),
    args: args.length > 0 ? args : undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
  };
}

function validateForm(f: FormData): string | null {
  if (!f.name.trim()) return "Name required";
  if (f.transport === "http" && !f.url.trim()) return "URL required";
  if (f.transport === "stdio" && !f.command.trim()) return "Command required";
  return null;
}

function KeyValueFields({
  label,
  fields,
  onChange,
}: {
  label: string;
  fields: KeyValueField[];
  onChange: (fields: KeyValueField[]) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-muted-foreground">{label}</Label>
        <button
          onClick={() => onChange([...fields, { key: "", value: "" }])}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          + Add
        </button>
      </div>
      {fields.map((field, index) => (
        <div key={index} className="flex items-center gap-1 mt-1">
          <Input
            value={field.key}
            onChange={(event) => onChange(fields.map((item, itemIndex) => (
              itemIndex === index ? { ...item, key: event.target.value } : item
            )))}
            placeholder="KEY"
            className="h-6 text-xs font-mono flex-1"
          />
          <span className="text-muted-foreground text-xs">=</span>
          <Input
            type={field.value === MCP_SECRET_MASK ? "password" : "text"}
            value={field.value}
            onChange={(event) => onChange(fields.map((item, itemIndex) => (
              itemIndex === index ? { ...item, value: event.target.value } : item
            )))}
            placeholder="value"
            className="h-6 text-xs font-mono flex-1"
          />
          <button
            onClick={() => onChange(fields.filter((_, itemIndex) => itemIndex !== index))}
            className="text-muted-foreground hover:text-destructive p-1"
          >
            <IconX className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ServerForm({
  data,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  data: FormData;
  onChange: (d: FormData) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormData>(k: K, v: FormData[K]) => {
    onChange({ ...data, [k]: v });
    setError(null);
  };
  const handleSubmit = () => {
    const err = validateForm(data);
    if (err) {
      setError(err);
      return;
    }
    onSubmit();
  };

  return (
    <div className="space-y-3 pt-2 border-t border-border/50">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[10px] text-muted-foreground">Name</Label>
          <Input value={data.name} onChange={(e) => set("name", e.target.value)} className="h-7 text-xs" />
        </div>
        <div>
          <Label className="text-[10px] text-muted-foreground">Transport</Label>
          <div className="flex gap-1">
            {(["stdio", "http"] as const).map((t) => (
              <button
                key={t}
                onClick={() => set("transport", t)}
                className={cn(
                  "flex-1 h-7 text-xs rounded border flex items-center justify-center gap-1",
                  data.transport === t ? "border-blue-500 bg-blue-500/10 text-blue-500" : "border-border",
                )}
              >
                {t === "stdio" ? <IconTerminal2 className="size-3" /> : <IconWorld className="size-3" />}
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data.transport === "http" ? (
        <>
          <div>
            <Label className="text-[10px] text-muted-foreground">URL</Label>
            <Input value={data.url} onChange={(e) => set("url", e.target.value)} placeholder="https://..." className="h-7 text-xs font-mono" />
            <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer">
              <input type="checkbox" checked={data.requiresAuth} onChange={(e) => set("requiresAuth", e.target.checked)} className="rounded size-3" />
              <span className="text-xs text-muted-foreground">Requires OAuth</span>
            </label>
          </div>
          <KeyValueFields
            label="Headers"
            fields={data.headerVars}
            onChange={(headerVars) => set("headerVars", headerVars)}
          />
          <div>
            <Label className="text-[10px] text-muted-foreground">Bearer Token Environment Variable</Label>
            <Input
              value={data.bearerTokenEnvVar}
              onChange={(e) => set("bearerTokenEnvVar", e.target.value)}
              placeholder="MCP_TOKEN"
              className="h-7 text-xs font-mono"
            />
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <div>
            <Label className="text-[10px] text-muted-foreground">Command</Label>
            <Input value={data.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" className="h-7 text-xs font-mono" />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-[10px] text-muted-foreground">Arguments</Label>
              <button
                onClick={() => set("args", [...data.args, ""])}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                + Add
              </button>
            </div>
            {data.args.map((arg, index) => (
              <div key={index} className="flex items-center gap-1 mt-1">
                <Input
                  value={arg}
                  onChange={(event) => set("args", data.args.map((item, itemIndex) => (
                    itemIndex === index ? event.target.value : item
                  )))}
                  placeholder={index === 0 ? "-y" : "@pkg/name"}
                  className="h-7 text-xs font-mono flex-1"
                />
                <button
                  onClick={() => set("args", data.args.filter((_, itemIndex) => itemIndex !== index))}
                  className="text-muted-foreground hover:text-destructive p-1"
                >
                  <IconX className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.transport === "stdio" && (
        <KeyValueFields
          label="Environment Variables"
          fields={data.envVars}
          onChange={(envVars) => set("envVars", envVars)}
        />
      )}

      {error && <p className="text-[10px] text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="h-6 text-xs" onClick={handleSubmit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function ServerItem({ server, onDelete }: { server: MCPServerConfig; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState(() => serverToForm(server));
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { setMCPServers } = useSettingsStore();

  const isHttp = server.transport === "http";

  const handleUpdate = async () => {
    try {
      const servers = await bridge.updateMCPServer(server.name, formToConfig(form));
      setMCPServers(servers);
      setExpanded(false);
    } catch (error) {
      setTestOutput(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleAction = async (action: () => Promise<any>) => {
    setIsLoading(true);
    setTestOutput(null);
    try {
      await action();
    } catch (error) {
      setExpanded(true);
      setTestOutput(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTest = () =>
    handleAction(async () => {
      setExpanded(true);
      const result = await bridge.testMCP(server.name);
      setTestOutput(result.output);
    });

  const handleAuth = () => handleAction(() => bridge.authMCP(server.name));
  const handleResetAuth = () => handleAction(() => bridge.resetAuthMCP(server.name));

  return (
    <div className="rounded-md border border-border/60 bg-card/30">
      <div className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/30" onClick={() => setExpanded(!expanded)}>
        <div className={cn("size-6 rounded flex items-center justify-center text-xs", isHttp ? "bg-blue-500/10 text-blue-500" : "bg-emerald-500/10 text-emerald-500")}>
          {isHttp ? <IconWorld className="size-3.5" /> : <IconTerminal2 className="size-3.5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{server.name}</span>
            {server.auth === "oauth" && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">OAuth</span>}
          </div>
          <p className="text-[10px] text-muted-foreground truncate font-mono">
            {isHttp ? server.url : (
              <>
                <span>{server.command}</span>
                {(server.args ?? []).map((arg, index) => <span key={index}> {arg}</span>)}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {server.auth === "oauth" && (
            <>
              <Button variant="ghost" size="icon" className="size-6" onClick={() => { void handleAuth(); }} disabled={isLoading}>
                <IconKey className="size-3" />
              </Button>
              <Button variant="ghost" size="icon" className="size-6" onClick={() => { void handleResetAuth(); }} disabled={isLoading}>
                <IconRefresh className="size-3" />
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" className="size-6" onClick={() => { void handleTest(); }} disabled={isLoading}>
            {isLoading ? <IconLoader2 className="size-3 animate-spin" /> : <IconPlugConnected className="size-3" />}
          </Button>
          <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" onClick={onDelete} disabled={isLoading}>
            <IconTrash className="size-3" />
          </Button>
        </div>
        <IconChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </div>

      {expanded && (
        <div className="px-2.5 pb-2.5">
          {testOutput && (
            <div className="text-[10px] font-mono bg-muted/50 rounded p-2 mb-2 max-h-48 overflow-auto border border-border/50">
              {testOutput.split("\n").map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all min-h-[1.2em]">
                  {line}
                </div>
              ))}
            </div>
          )}
          <ServerForm data={form} onChange={setForm} onSubmit={() => { void handleUpdate(); }} onCancel={() => setExpanded(false)} submitLabel="Update" />
        </div>
      )}
    </div>
  );
}

function RecommendedItem({ server, onInstall, isInstalling }: { server: RecommendedMCPServer; onInstall: () => void; isInstalling: boolean }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-dashed border-border/50">
      <div className="size-6 rounded flex items-center justify-center bg-violet-500/10 text-violet-500">
        <IconTerminal2 className="size-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">{server.name}</span>
          {server.github && (
            <a href={server.github} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
              <IconBrandGithub className="size-3" />
            </a>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground truncate">{server.description}</p>
      </div>
      <Button variant="outline" size="sm" className="h-6 text-xs" onClick={onInstall} disabled={isInstalling}>
        {isInstalling ? (
          <>
            <IconLoader2 className="size-3 mr-1 animate-spin" />
            Adding
          </>
        ) : (
          "Add"
        )}
      </Button>
    </div>
  );
}

export function MCPServersModal() {
  const { mcpServers, mcpModalOpen, setMCPServers, setMCPModalOpen } = useSettingsStore();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<FormData>(() => emptyForm());
  const [installingRecommended, setInstallingRecommended] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (mcpModalOpen) {
      void bridge.getMCPServers().then(setMCPServers).catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    }
  }, [mcpModalOpen, setMCPServers]);

  useEffect(() => {
    if (!showAdd) setAddForm(emptyForm());
  }, [showAdd]);

  const installedNames = useMemo(() => new Set(mcpServers.map((s) => s.name)), [mcpServers]);

  const handleAdd = async () => {
    setActionError(null);
    try {
      const servers = await bridge.addMCPServer(formToConfig(addForm));
      setMCPServers(servers);
      setShowAdd(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    setActionError(null);
    try {
      const servers = await bridge.removeMCPServer(deleteTarget);
      setMCPServers(servers);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    setIsDeleting(false);
    setDeleteTarget(null);
  };

  const handleInstallRecommended = async (server: RecommendedMCPServer) => {
    setInstallingRecommended(server.id);
    setActionError(null);
    try {
      const config = recommendedToConfig(server);
      const servers = await bridge.addMCPServer(config);
      setMCPServers(servers);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    setInstallingRecommended(null);
  };

  if (!mcpModalOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 flex flex-col bg-background">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <div className="flex items-center gap-2">
            <IconServer className="size-4 text-blue-500" />
            <h2 className="text-xs font-medium">MCP Servers</h2>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setShowAdd(true)}>
              <IconPlus className="size-3 mr-1" />
              Add
            </Button>
            <Button variant="ghost" size="icon" className="size-6" onClick={() => setMCPModalOpen(false)}>
              <IconX className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-3 py-3 space-y-4">
            {actionError && (
              <div className="rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                {actionError}
              </div>
            )}
            {showAdd && (
              <div className="rounded-md border border-blue-500/5 p-2.5">
                <div className="flex items-center gap-2 mb-2">
                  <IconPlus className="size-3.5 text-blue-500" />
                  <span className="text-xs font-medium">Add MCP Server</span>
                </div>
                <ServerForm data={addForm} onChange={setAddForm} onSubmit={() => { void handleAdd(); }} onCancel={() => setShowAdd(false)} submitLabel="Add Server" />
              </div>
            )}

            {mcpServers.length > 0 && (
              <div className="space-y-1.5">
                {mcpServers.map((server) => (
                  <ServerItem key={server.name} server={server} onDelete={() => setDeleteTarget(server.name)} />
                ))}
              </div>
            )}

            {mcpServers.length === 0 && !showAdd && (
              <div className="py-6 text-center">
                <IconServer className="size-6 mx-auto text-muted-foreground/30 mb-1" />
                <p className="text-xs text-muted-foreground">No MCP servers configured</p>
              </div>
            )}

            <div className="space-y-1.5">
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Recommended</h3>
              {RECOMMENDED_MCP_SERVERS.filter((s) => !installedNames.has(s.id)).map((server) => (
                <RecommendedItem key={server.id} server={server} onInstall={() => { void handleInstallRecommended(server); }} isInstalling={installingRecommended === server.id} />
              ))}
              {RECOMMENDED_MCP_SERVERS.every((s) => installedNames.has(s.id)) && (
                <p className="text-[10px] text-muted-foreground text-center py-2">All recommended servers installed</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP Server?</AlertDialogTitle>
            <AlertDialogDescription>This will remove "{deleteTarget}" from your configuration. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { void handleDelete(); }} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
