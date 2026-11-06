# `kimi acp` Subcomando

O `kimi acp` muda a Kimi Code CLI para o modo **ACP (Agent Client Protocol)**: ele se comunica com um cliente ACP (como Zed, JetBrains AI Chat, etc.) via JSON-RPC por meio de stdin/stdout, permitindo que a IDE controle diretamente as sessões, prompts e chamadas de ferramentas do kimi.

```sh
kimi acp
```

Uma vez iniciado, o comando não imprime nenhum banner e aguarda imediatamente que o cliente ACP envie uma requisição `initialize` no stdin. Os logs são gravados no stderr (assim como o log de diagnóstico em `~/.kimi-code/logs/`), para que o próprio canal ACP permaneça limpo.

::: tip Quem chama isso?
Geralmente você não precisa executar o `kimi acp` manualmente — este comando é o ponto de entrada do subprocesso para as IDEs. Para a configuração no lado da IDE, veja [Using in IDEs](../guides/ides.md).
:::

## Matriz de capacidades

A tabela abaixo lista as capacidades declaradas pelo servidor ACP. O campo `agentCapabilities` é retornado na íntegra na resposta do `initialize`, para que a IDE possa ajustar sua interface adequadamente.

| Capacidade | Valor | Descrição |
| --- | --- | --- |
| `loadSession` | `true` | Suporta `session/load` para retomar uma sessão existente, reproduzindo (*replaying*) o histórico no carregamento |
| `promptCapabilities.image` | `true` | Suporta blocos de conteúdo `image` do ACP (base64 + mimeType) |
| `promptCapabilities.audio` | `false` | Prompts de áudio ainda não suportados |
| `promptCapabilities.embeddedContext` | `true` | O cliente pode enviar blocos de recursos embutidos `resource`/`resource_link`; o conteúdo de texto é injetado no prompt como `<resource uri="...">...</resource>`; recursos do tipo blob são descartados com um aviso (*warn*) |
| `sessionCapabilities.list` | `{}` | Suporta `session/list` para enumerar as sessões do usuário atual |
| `sessionCapabilities.resume` | `{}` | Suporta `session/resume` para reconectar a uma sessão sem reproduzir (*replay*) o histórico |
| `sessionCapabilities.close` | `{}` | Suporta `session/close` para encerrar uma sessão ativa |
| `sessionCapabilities.delete` | `{}` | Suporta `session/delete` para remover permanentemente uma sessão |
| `sessionCapabilities.fork` | `{}` | Suporta `session/fork` para ramificar (*branch*) uma sessão existente |
| `sessionCapabilities.additionalDirectories` | `{}` | Diretórios de trabalho extras; honrados apenas no `session/new` |
| `mcpCapabilities.http` | `true` | Encaminha serviços MCP HTTP configurados pela IDE |
| `mcpCapabilities.sse` | `true` | Encaminha serviços MCP legados SSE configurados pela IDE |
| `auth.logout` | `{}` | Suporta `logout` do ACP para descartar o token do provedor gerenciado |

## Cobertura de métodos ACP

Com `@agentclientprotocol/sdk@1.x`, o conjunto de métodos ACP é organizado por namespace: `core` e `session` cobrem o fluxo principal do agente, enquanto `providers`, `nes` (previsão de edição inline) e `document` (sincronização de buffer) são superfícies de extensão opcionais. No lado do cliente, os métodos de RPC reverso (*reverse-RPC*) são agrupados em `session`, `fs`, `terminal` e `elicitation`.

**Resumo: o servidor ACP implementa toda a superfície principal (core) (3/3) e de sessão (11/11) do lado do agente, 10/11 métodos de RPC reverso do cliente e a extensão `session/set_model`. Não implementados: `providers/*`, `nes/*`, `document/*` e `elicitation/complete` — requisições para eles retornam `methodNotFound`.**

### Core lado do agente — IDE → agente (3 / 3)

| Método | Implementado | Descrição |
| --- | --- | --- |
| `initialize` | Sim | Negociação de versão; retorna `agentInfo: { name: 'Kimi Code CLI', version }`, matriz de capacidades e `authMethods` (`type:'terminal'` de primeira classe mais o fallback legado `_meta['terminal-auth']`) |
| `authenticate` | Sim | Valida `method_id='login'`; retorna `authRequired (-32000)` se o token estiver ausente, `invalidParams (-32602)` para um ID desconhecido |
| `logout` | Sim | Descarta o token do provedor gerenciado; chamadas restritas subsequentes retornam `auth_required` novamente |

### Sessão lado do agente — IDE → agente (11 / 11)

| Método | Implementado | Descrição |
| --- | --- | --- |
| `session/new` | Sim | Aceita `cwd` / `mcpServers` / `additionalDirectories`; retorna `sessionId` + `configOptions[]` + `modes` |
| `session/load` | Sim | Restaura uma sessão do disco e reproduz o histórico via `session/update` antes de concluir a resposta |
| `session/resume` | Sim | Versão mais leve do `session/load`; pula a reprodução (*replay*) do histórico |
| `session/list` | Sim | Enumera as sessões no disco, filtráveis por `cwd` |
| `session/fork` | Sim | Ramifica (*branches*) uma sessão de origem; `cwd` / `additionalDirectories` / `mcpServers` na requisição são ignorados com um aviso |
| `session/close` | Sim | Encerramento com o melhor esforço: cancela qualquer turno em andamento, descarta recursos por sessão e fecha a sessão ativa; um id desconhecido não é um erro |
| `session/delete` | Sim | Remove permanentemente uma sessão e seus dados persistidos; um id desconhecido retorna `invalidParams (-32602)` |
| `session/prompt` | Sim | Aceita blocos de conteúdo `text` / `image` / `resource` / `resource_link`; transmite (streams) `agent_message_chunk` |
| `session/cancel` | Sim | Interrompe o turno atual (um `$/cancel_request` do JSON-RPC para um prompt cai no mesmo caminho de cancelamento) |
| `session/set_mode` | Sim | Valida `modeId`; a mesma mudança de modo subjacente de `set_config_option({configId:'mode'})` |
| `session/set_config_option` | Sim | Despachante unificado de seleção de modelo / pensamento (*thinking*) / modo |

### RPC Reverso lado do cliente — agente → IDE (10 / 11)

| Método | Implementado | Descrição |
| --- | --- | --- |
| `session/update` | Sim | Transmite (streams) `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | Sim | Canal compartilhado para aprovação de ferramentas e prompts de perguntas |
| `fs/read_text_file` | Sim | Leituras de arquivos da engine são roteadas para o cliente quando ele anuncia `fsCapabilities` |
| `fs/write_text_file` | Sim | Gravações de arquivos da engine são roteadas para o cliente |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | Sim | Execuções de shell fazem RPC reverso para o cliente quando ele anuncia `clientCapabilities.terminal` |
| `elicitation/create` | Sim | Perguntas do tipo "perguntar ao usuário" passam pelo formulário nativo quando o cliente anuncia `elicitation.form`; falhas de RPC fazem fallback para `session/request_permission` |
| `elicitation/complete` | Não | |

### Métodos de extensão

| Método | Implementado | Descrição |
| --- | --- | --- |
| `session/set_model` | Sim | Trazido da superfície instável do ACP 0.23 como um método de extensão; equivalente a `set_config_option({configId:'model'})` |

Todos os métodos não listados acima retornam `methodNotFound`.

## Encaminhamento MCP (MCP forwarding)

Quando um cliente ACP fornece `mcpServers` em `session/new` ou `session/load`, o servidor ACP realiza as seguintes conversões:

- `http` → configuração `transport: 'http'` do kimi
- `stdio` → configuração `transport: 'stdio'` do kimi
- `sse` → configuração `transport: 'sse'` do kimi
- `acp` → descartado com um aviso (*warn*) no log

## Próximos passos

- [Using in IDEs](../guides/ides.md) — Passos de configuração e solução de problemas para Zed / JetBrains
- [`kimi` Command Reference](./kimi-command.md) — Lista completa de subcomandos