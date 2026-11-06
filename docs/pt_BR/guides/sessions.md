# Sessões e contexto

A Kimi Code CLI mantém cada conversa como uma "sessão" — armazenando o histórico de mensagens e metadados, de modo que você possa fechar o terminal e retomar exatamente de onde parou. Esta página aborda como retomar sessões, gerenciar o contexto, além de exportar ou criar ramificações (forks) de sessões.

## Armazenamento de sessões

Todas as sessões são salvas em `$KIMI_CODE_HOME/sessions/` (padrão: `~/.kimi-code/sessions/`), agrupadas por diretório de trabalho:

```text
~/.kimi-code/
├── config.toml
├── session_index.jsonl
└── sessions/
    └── <workDirKey>/
        └── <sessionId>/
            ├── state.json
            └── agents/
                ├── main/
                │   └── wire.jsonl
                └── <subagentId>/
                    └── wire.jsonl
```

- `state.json`: metadados da sessão, como título e data de criação.
- `agents/*/wire.jsonl`: fluxo de eventos do agente, utilizado para a recuperação e reprodução (replay) de sessões. Também contém um rastreamento de requisições — incluindo esquemas de ferramentas, parâmetros de requisição e listagens de ferramentas MCP enviadas ao modelo — para fins de depuração.

::: warning
Não edite manualmente os arquivos dentro do diretório `sessions/` — fazer isso pode impedir que as sessões sejam restauradas corretamente.
:::

## Iniciando e retomando sessões

Cada vez que você executa o `kimi` diretamente, uma nova sessão é criada. Para retomar uma sessão anterior, utilize uma das seguintes opções:

**Retomar a sessão mais recente no diretório atual:**

```sh
kimi --continue
```

**Retomar uma sessão específica por meio de seu ID:**

```sh
kimi --session abc123
```

**Navegar interativamente pelo histórico de sessões e selecionar uma delas:**

```sh
kimi --session
```

::: warning
As opções `--continue` e `--session` são mutuamente exclusivas.
:::

## Alternando sessões na TUI

Você pode gerenciar sessões sem sair do terminal. Os seguintes comandos (iniciados por barra) estão disponíveis apenas quando o agente está ocioso:

- **`/new`** (apelido `/clear`): alterna para uma nova sessão, descartando o contexto atual.
- **`/sessions`** (apelido `/resume`): navega por sessões anteriores e retoma uma delas.
- **`/fork`**: cria uma ramificação (fork) da sessão atual (veja abaixo).
- **`/title <texto>`** (apelido `/rename`): define um título para a sessão, facilitando sua identificação; se nenhum argumento for fornecido, exibe o título atual.

## Compressão de contexto

À medida que uma conversa avança, a Kimi Code CLI comprime automaticamente o histórico de mensagens quando o contexto se aproxima do limite da janela, liberando espaço de tokens. Você também pode acionar a compressão manualmente a qualquer momento:

```
/compact
```

É possível fornecer uma instrução para orientar o modelo sobre o que priorizar durante a compressão:

```
/compact Mantenha a discussão focada em migrações de banco de dados
```

## Criação de uma ramificação (fork) de sessão

Para explorar uma nova direção sem interferir na conversa atual, utilize o comando `/fork`:

```
/fork
```

Ao criar uma ramificação, você não sai da sessão original; ela permanece inalterada e a conversa continua como estava. A ramificação é uma cópia independente, para a qual você pode alternar a qualquer momento usando o comando `/sessions`. Um `/goal` (objetivo) definido na sessão original não é copiado para a nova ramificação. Caso deseje trabalhar em um objetivo de forma autônoma na nova ramificação, será necessário definir um novo objetivo nela.

Após a criação da ramificação, a CLI exibirá um comando `kimi --resume` pronto para uso (que também é copiado para a área de transferência), permitindo que você acesse a nova ramificação diretamente a partir de um novo processo no terminal.

## Exportando uma sessão

Use `kimi export` para empacotar uma sessão em um arquivo ZIP — útil para compartilhamento, arquivamento ou envio de um relatório de erro:

```sh
kimi export <sessionId>
```

Se você omitir o `sessionId`, o comando exportará a sessão mais recente no diretório atual (será solicitada uma confirmação interativa; adicione `-y` para pular essa etapa). Use `-o` para especificar um caminho de destino:

```sh
kimi export <sessionId> -o ~/Desktop/my-session.zip
```

A exportação inclui todos os arquivos presentes no diretório da sessão, inclusive logs de diagnóstico. O log de diagnóstico global (`~/.kimi-code/logs/kimi-code.log`) também é incluído por padrão; adicione `--no-include-global-log` caso deseje excluí-lo.

Você também pode realizar a exportação a partir da TUI (interface baseada em terminal), sem precisar sair da sessão interativa:

- **`/export-debug-zip`**: gera o mesmo arquivo ZIP de depuração que o comando `kimi export`.
- **`/export-md`** (ou o alias `/export`): exporta a conversa como um arquivo Markdown legível, ideal para compartilhamento ou arquivamento. Aceita um argumento de caminho opcional; caso não seja fornecido, o arquivo será salvo como `kimi-export-<short-id>-<timestamp>.md` no diretório de trabalho atual.

Na interface web (web UI), o comando `/export` realiza o download da sessão atual como um arquivo ZIP de diagnóstico. Ele contém os dados persistidos da sessão, logs de diagnóstico e um registro limitado — contendo apenas metadados — em `logs/kimi-web.jsonl`, que documenta os principais eventos do navegador. O texto dos prompts, payloads de WebSocket e argumentos de console não são incluídos nesse log do navegador. Este comando na interface web difere do alias `/export` mencionado anteriormente para a TUI.

::: dica
Arquivos exportados podem conter código, saídas de comandos e caminhos de arquivos que contêm informações sensíveis. Revise o conteúdo antes de compartilhá-lo.
:::

## Próximos passos

- [Locais dos dados](../configuration/data-locations.md) — estrutura completa de diretórios para arquivos de sessão
- [Referência de comandos do kimi](../reference/kimi-command.md) — referência completa de parâmetros para `--continue`, `--session`, `export` e outros comandos