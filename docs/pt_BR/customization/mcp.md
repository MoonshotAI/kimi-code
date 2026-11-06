# Protocolo de Contexto de Modelo

[Protocolo de Contexto de Modelo (MCP)](https://modelcontextprotocol.io/) é um protocolo aberto que permite modelos invoquem com segurança ferramentas expostas por processos ou serviços externos: lendo issues do GitHub, consultando bancos de dados ou operando o sistema de arquivo local. Kimi Code CLI age como um cliente MCP para conectar essas ferramentas externas e expô-las ao Agente junto das ferramentas integradas (`Read`, `Bash`, `Grep`, etc.) sem alteração de comportamento.

Resultados das ferramentas MCP podem incluir texto (`content`) e dados estruturados (`structuredContent`). Kimi Code CLI torna ambos disponíveis ao agente e omite a cópia estruturada apenas quando puder confirmar que um bloco de texto já contenha o mesmo valor JSON completo. Resumos de textos e mídia não substituem registros estruturados.

## Métodos de Conexão

Kimi Code CLI apoia três métodos de conexão com servidores MCP:

- **stdio**: A CLI começa o servidor MCP local como um processo filho e se comunica através do processo input/output padrão. Adequado para ferramentas de linha de comando locais.
- **HTTP**: A CLI conecta a um endpoint HTTP+SSE legado (Server-Sent Events, um mecanismo de streaming HTTP). Prefere HTTP para novos servidorees MCP, mas use `transport: "sse"` quando um serviço ainda expuser apenas o transporte SSE mais antigo.

## Configuração

A configuração de servidor MCP é escrita em `mcp.json`, em dois níveis:

- **User level**: `~/.kimi-code/mcp.json` (ou `$KIMI_CODE_HOME/mcp.json`), compartilhado entre projetos
- **Project level**: `.kimi-code/mcp.json` no diretório em funcionamento, efetivo apenas para o repositório atual

Entradas com o mesmo nome: a entrada em nível de projeto possui precedência e prevalece sobre a entrada em nível de usuário.

Execute `/mcp-config` na TUI para interativamente adicionar, editar ou deletar servidores sem editar manualmente o arquivo JSON. Execute `/mcp` para ver os status de conexão de todos os servidores atuais.

Deletar um servidor das configurações não interrompe sessões abertas: o servidor permanece listado em `/mcp` como `removed`, suas ferramentas permanecem visíveis lá, e chamadas a eles falham com um aviso de remoção, enquanto que novas sessões não registram as ferramentas. Por outro lado, um servidor adicionado durante a sessão, seja editando o arquivo `mcp.json` ou instalando um plugin, não é registrado nas sessões já abertas; ele passa a integrar apenas as sessões criadas posteriormente.

Quando o Kimi Code encontra servidores MCP em nível de projeto em uma pasta não confiável, ele exibe o transporte e o destino de inicialização de cada servidor na solicitação de confiança do workspace. A opção padrão da solicitação é "Confiar nesta pasta"; analisar o comando e os argumentos listados ou a URL remota antes de confirmar. Confiar na pasta habilita os servidores MCP em nível de projeto para aquele workspace.

Estrutura do `mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    },
    "legacy-events": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

Entradas com um campo `command` são servidores stdio; entradas com um campo `url` e sem `transport` são servidores HTTP. Para servidores SSE legados, defina `transport` explicitamente como `"sse"`.

Campos opcionais:

| Campo | Tipo | Aplica-se a | Descrição |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | Variáveis ​​de ambiente injetadas no processo filho |
| `cwd` | `string` | stdio | Diretório de trabalho do processo filho |
| `headers` | `Record<string, string>` | HTTP, SSE | Cabeçalhos de requisição estáticos adicionados a todas as requisições |
| `bearerTokenEnvVar` | `string` | HTTP, SSE | Nome de uma variável de ambiente que contém um token bearer |
| `enabled` | `boolean` | Todos | Defina como `false` para desativar este servidor |
| `startupTimeoutMs` | `number` | Todos | Tempo limite de conexão de `1` a `2147483647` milissegundos; padrão `30000` |
| `toolTimeoutMs` | `number` | Todos | Tempo limite de `1` a `2147483647` milissegundos para uma única chamada de ferramenta |
| `enabledTools` | `string[]` | Todos | Lista de permissão de ferramentas |
| `disabledTools` | `string[]` | Todos | Lista de bloqueio de ferramentas |

Não é necessário definir o tempo limite de conexão ou o tempo limite de chamada de ferramenta individual por servidor: as configurações `[mcp] startup_timeout_ms` / `[mcp] tool_timeout_ms` no `config.toml` ou as variáveis ​​de ambiente `KIMI_MCP_STARTUP_TIMEOUT_MS` / `KIMI_MCP_TOOL_TIMEOUT_MS` alteram os padrões globais. A ordem de precedência é: campo específico do servidor > variável de ambiente > `config.toml` > padrão interno. Consulte [Arquivos de configuração](../configuration/config-files.md#mcp).

Servidores HTTP e SSE oferecem suporte ao fornecimento de credenciais estáticas via `headers` ou `bearerTokenEnvVar`. Quando o OAuth for necessário, execute `/mcp-config login <server-name>` para concluir a autorização via navegador.

Plugins também podem declarar servidores MCP em seus manifestos. Servidores declarados por um plugin são habilitados por padrão e podem ser desabilitados ou reabilitados em `/plugins`: desabilitar ou remover um deles faz com que chamadas de sessões abertas falhem com uma notificação de remoção, enquanto adicionar ou habilitar um servidor o conecta imediatamente às sessões abertas. Consulte [Plugins](./plugins.md#mcp-servers-in-plugins) para obter detalhes.

::: Nota de aviso
Entradas stdio em um arquivo `.kimi-code/mcp.json` no nível do projeto executam comandos locais quando uma sessão é iniciada. Habilite-as apenas em repositórios nos quais você confia.
:::

## Nomenclatura e Permissões de Ferramentas

As ferramentas MCP seguem o formato `mcp__<server>__<tool>`; por exemplo, `mcp__github__create_issue`. As regras de permissão aceitam os caracteres curinga `*` e `**`; por exemplo, `mcp__github__*` corresponde a todas as ferramentas desse servidor. Os parâmetros das ferramentas MCP não são considerados na verificação de permissões.

Chamadas que não correspondem a nenhuma regra de permissão acionam uma solicitação de aprovação. Selecionar "Aprovar para esta sessão" na caixa de diálogo de aprovação permite automaticamente chamadas subsequentes do mesmo tipo durante a sessão atual.

Você também pode pré-configurar regras permanentes em `[[permission.rules]]` no `config.toml`:

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```
Para a sintaxe completa das regras de permissão, consulte [Arquivos de configuração](../configuration/config-files.md#permission).

## Segurança

Ao se conectar a servidores MCP externos, leve em consideração o seguinte:

- Conecte-se apenas a servidores de fontes confiáveis
- Verifique se os nomes das ferramentas e os parâmetros parecem razoáveis ​​nas solicitações de aprovação
- Mantenha a aprovação manual para ferramentas de alto risco (escrita de arquivos, execução de comandos, etc.); evite usar curingas como `mcp__*` para permitir todas as ferramentas de uma só vez

::: Nota de aviso
Em [Ask When Needed mode](../guides/interaction.md#the-three-permission-modes), as chamadas de ferramentas MCP são aprovadas automaticamente. Utilize este modo apenas quando confiar plenamente nos servidores MCP aos quais você se conectou.
:::

## Próximos passos

- [Plugins](./plugins.md) — Declara servidores MCP em um manifesto de plugin para empacotá-los e distribuí-los em conjunto
- [Arquivos de configuração](../configuration/config-files.md#permission) — Referência completa de campos para regras de permissão