# @moonshot-ai/acp-adapter

Agent Client Protocol adapter for kimi-code. Exposes the kimi-code agent over the [Agent Client Protocol](https://agentclientprotocol.com/) so that ACP-compatible clients (editors, IDEs, custom front-ends) can drive a kimi-code session over stdio.

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo.

## Minimum usage

```ts
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { runAcpServer } from '@moonshot-ai/acp-adapter';

const harness = await createKimiHarness();
await runAcpServer(harness);
```

`runAcpServer` reads JSON-RPC from `process.stdin`, writes to `process.stdout`, and resolves when the client closes the connection. SIGINT and SIGTERM trigger a graceful drain that calls `harness.close()` before the process exits.

See `docs/zh/reference/kimi-acp.md` for the full capability matrix (which `Agent` methods are wired, which extensions are stubbed, image / MCP support) and `docs/zh/guides/ides.md` for Zed and JetBrains setup.

## License

MIT
