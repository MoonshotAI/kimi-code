# Localização dos dados

O Kimi Code CLI armazena o arquivo de configuração, o histórico de sessões, as credenciais de login, os logs de diagnóstico e outros dados de execução em `~/.kimi-code/`. Esta página ajuda você a entender onde cada tipo de dado fica, para que serve e como limpá-lo ou movê-lo quando necessário.

## Diretório raiz de dados

O diretório raiz de dados padrão é `~/.kimi-code/`. O caminho real varia conforme a plataforma:

- macOS: `/Users/<name>/.kimi-code`
- Linux: `/home/<name>/.kimi-code`
- Windows: `C:\Users\<name>\.kimi-code`

Se precisar mover o diretório de dados para outro lugar (por exemplo, para isolar configurações de diferentes projetos em ambientes independentes), defina `KIMI_CODE_HOME`:

```sh
export KIMI_CODE_HOME="$HOME/.config/kimi-code"
```

Depois de definida, **todos** os dados do Kimi Code passam a ficar no novo caminho: configuração, sessões, logs, credenciais OAuth, Skills de usuário específicas do Kimi, `AGENTS.md` global e muito mais. Para a referência completa sobre `KIMI_CODE_HOME`, consulte [Variáveis de ambiente](./env-vars.md).

::: tip Nota

Os **recursos genéricos de `.agents`** permanecem no diretório home real do sistema operacional, para que possam ser compartilhados entre ferramentas. Por exemplo, as Skills genéricas de nível de usuário continuam em `~/.agents/skills/`, enquanto as Skills de usuário específicas do Kimi acompanham `KIMI_CODE_HOME` e ficam em `$KIMI_CODE_HOME/skills/`.
:::

## Estrutura de diretórios

```
$KIMI_CODE_HOME  (padrão: ~/.kimi-code)
├── config.toml             # Configuração do usuário
├── tui.toml                # Preferências da interface de terminal (incluindo a opção de atualização automática)
├── AGENTS.md               # Instruções globais do agente específicas do Kimi (opcional)
├── mcp.json                # Declarações de servidores MCP no nível do usuário (opcional)
├── skills/                 # Skills de nível de usuário específicas do Kimi (opcional)
├── plugins/
│   ├── installed.json      # Registros de plugins instalados e estado de ativação
│   └── managed/            # Cópias de plugins instalados a partir de zip/caminhos locais
├── session_index.jsonl     # Índice de sessões
├── credentials/            # Credenciais OAuth (diretório 0700, arquivos 0600)
│   ├── <name>.json
│   └── mcp/
│       └── <key>-<suffix>.json
├── sessions/               # Dados de sessão (veja abaixo)
│   └── <workDirKey>/<sessionId>/
├── bin/
│   ├── rg                  # binário gerenciado do ripgrep para o Grep (rg.exe no Windows)
│   └── fd                  # binário gerenciado do fd para referências de arquivos (fd.exe no Windows)
├── logs/
│   └── kimi-code.log       # Log de diagnóstico global
├── updates/
│   ├── latest.json
│   ├── install.json
│   ├── install.lock
│   └── rollout.log
└── user-history/
    └── <md5(workDir)>.jsonl
```

## Descrição dos arquivos

Cada arquivo de nível superior no diretório raiz de dados tem uma finalidade específica; a maioria é gerenciada automaticamente pelo CLI:

- **`config.toml`**: o principal arquivo de configuração de execução, que armazena ajustes de nível de usuário, como provedores, modelos e controle de loop. Consulte [Arquivos de configuração](./config-files.md).
- **`tui.toml`**: preferências do cliente da interface de terminal, incluindo `[upgrade].auto_install` (atualização automática, ativada por padrão). Você pode desativá-la em `/settings` ou definindo manualmente `auto_install = false`.
- **`AGENTS.md`**: instruções globais do agente específicas do Kimi. Este arquivo acompanha `KIMI_CODE_HOME`; instruções genéricas, compartilhadas entre ferramentas, ainda podem ficar em `~/.agents/AGENTS.md`.
- **`mcp.json`**: declarações de servidores MCP no nível do usuário, mescladas na inicialização com o `.kimi-code/mcp.json` local do projeto. Consulte [MCP](../customization/mcp.md).
- **`skills/`**: Skills de nível de usuário específicas do Kimi. Este diretório acompanha `KIMI_CODE_HOME`; Skills genéricas, compartilhadas entre ferramentas, ainda podem ficar em `~/.agents/skills/`. Consulte [Agent Skills](../customization/skills.md).
- **`plugins/installed.json`**: registra os plugins instalados, o estado de ativação de cada um e as alterações de estado da capacidade de servidores MCP feitas por meio de `/plugins` ou `/plugins mcp disable|enable`. Os arquivos instalados a partir de caminhos locais ou URLs de zip são copiados para `plugins/managed/<id>/`. Consulte [Plugins](../customization/plugins.md).
- **`credentials/`**: diretório de credenciais OAuth, com permissões `0o700` (diretório) e `0o600` (arquivos), legível e gravável apenas pelo usuário atual. As credenciais de provedores gerenciados são armazenadas como `credentials/<name>.json`; as credenciais de servidores MCP são armazenadas em `credentials/mcp/`. As credenciais são gravadas por meio de um fluxo atômico (tmp → fsync → rename) para evitar corrupção.

## Dados de sessão

Os dados de cada sessão ficam em `sessions/<workDirKey>/<sessionId>/`, e é mantido um índice de nível superior, `session_index.jsonl` (um registro por linha, cada um contendo `sessionId`, `sessionDir` e `workDir`). `workDirKey` é um nome de grupo derivado do caminho do diretório de trabalho, no formato `wd_<slug>_<primeiros-12-caracteres-do-sha256>`.

Dentro do diretório de cada sessão:

- **`state.json`**: metadados da sessão, incluindo título, `lastPrompt`, carimbos de data/hora de criação e atualização e `forkedFrom`.
- **`upcoming-goals.json`**: a fila exclusiva da TUI criada por `/goal next <objective>`. Ela não faz parte da conversa do agente até que um objetivo da fila seja promovido, depois que o objetivo atual for concluído.
- **`agents/main/wire.jsonl`**: o registro completo de comunicação do Agent principal, usado para retomar e reproduzir a sessão.
- **`agents/main/plans/`**: arquivos de plano gravados no modo Plan, nomeados pelo id do plano (`<id>.md`).
- **`agents/agent-0/` etc.**: diretórios de instâncias de sub-Agents, cada um contendo seu próprio `wire.jsonl`.
- **`logs/kimi-code.log`**: log de diagnóstico desta sessão; só existe quando ocorre algum evento de diagnóstico.
- **`tasks/`**: persistência de tarefas em segundo plano. `tasks/<task_id>.json` armazena status/pid/código de saída; `tasks/<task_id>/output.log` armazena a saída.
- **`cron/`**: persistência de tarefas agendadas; é recarregada no agendador quando a sessão é retomada com `kimi --session`. Consulte [Tarefas agendadas](../reference/tools.md#scheduled-tasks).

## Cache de ferramentas integradas

Na primeira vez que a ferramenta `Grep` precisa do ripgrep, o CLI pode baixar o `rg` automaticamente e armazená-lo em cache em `bin/rg` (`bin/rg.exe` no Windows). O preenchimento automático de referências de arquivos na interface de terminal usa o `fd`; o CLI o baixa e o armazena em cache em `bin/fd` (`bin/fd.exe` no Windows) em segundo plano quando necessário. As execuções seguintes reutilizam os binários em cache. O `rg` dá preferência ao `PATH` do sistema antes do cache, enquanto o `fd` verifica o cache gerenciado antes de recorrer ao `fd` / `fdfind` do sistema. Excluir o diretório `bin/` aciona um novo download no próximo uso.

## Logs e estado de atualização

- **`logs/kimi-code.log`** (global): registra a inicialização, o login, a exportação e outros eventos que abrangem várias sessões.
- **`<sessionDir>/logs/kimi-code.log`** (da sessão): registra eventos de diagnóstico dentro de uma única sessão.

Ao relatar um bug, prefira exportar a sessão relevante com `kimi export` (consulte o [comando kimi](../reference/kimi-command.md)); o log da sessão é incluído na exportação por padrão. Adicione `--no-include-global-log` se não quiser compartilhar o log global.

Os arquivos em `updates/` (`latest.json`, `install.json`, `install.lock`, `rollout.log`) são mantidos automaticamente pelo mecanismo de atualização automática e normalmente não precisam de edição manual. O `rollout.log` registra qual caso de lançamento gradual foi atingido em cada verificação de atualização, o que ajuda a explicar quando um dispositivo receberá uma nova versão.

## Histórico de entrada

O histórico de entrada do terminal é salvo separadamente para cada diretório de trabalho, em `user-history/<md5(workDir)>.jsonl`. Ele é usado para navegar pelos prompts digitados anteriormente na interface de terminal com as setas do teclado.

## Limpeza de dados

Excluir o diretório raiz de dados (`~/.kimi-code/` ou o caminho definido por `KIMI_CODE_HOME`) remove todos os dados de execução. Para limpar apenas parte dos dados:

| Objetivo | Ação |
| --- | --- |
| Redefinir a configuração | Excluir `~/.kimi-code/config.toml` |
| Redefinir as preferências da interface de terminal | Excluir `~/.kimi-code/tui.toml` |
| Limpar todas as sessões | Excluir `~/.kimi-code/sessions/` e `session_index.jsonl` |
| Limpar os logs de diagnóstico | Excluir `~/.kimi-code/logs/` |
| Limpar o histórico de entrada | Excluir `~/.kimi-code/user-history/` |
| Redefinir o estado de atualização | Excluir `~/.kimi-code/updates/latest.json` |
| Forçar o novo download do `rg` e do `fd` gerenciados | Excluir `~/.kimi-code/bin/` |
| Limpar o estado de login OAuth do provedor | Executar `/logout`, ou excluir o `credentials/<name>.json` correspondente |
| Limpar o estado de login OAuth do servidor MCP | Excluir `credentials/mcp/` (`/logout` não limpa as credenciais MCP) |
| Remover as declarações MCP no nível do usuário | Excluir `$KIMI_CODE_HOME/mcp.json` (padrão `~/.kimi-code/mcp.json`) |
| Limpar as instruções globais do agente específicas do Kimi | Excluir `$KIMI_CODE_HOME/AGENTS.md` (padrão `~/.kimi-code/AGENTS.md`) |
| Limpar os registros de instalação de plugins | Excluir `$KIMI_CODE_HOME/plugins/` (os diretórios de origem de plugins locais não são afetados) |
| Limpar as Skills de nível de usuário específicas do Kimi | Excluir `$KIMI_CODE_HOME/skills/` (padrão `~/.kimi-code/skills/`) |

## Próximos passos

- [Arquivos de configuração](./config-files.md) — referência completa dos campos do `config.toml`
- [Variáveis de ambiente](./env-vars.md) — uso detalhado de `KIMI_CODE_HOME` e de variáveis de caminho relacionadas