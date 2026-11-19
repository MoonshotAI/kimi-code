# Comandos Slash

Os comandos slash (comandos de barra) são comandos de controle integrados fornecidos pela CLI do Kimi Code na TUI (Interface de Usuário de Terminal) interativa, abrangendo configuração de conta, gerenciamento de sessão, alternância de modos, consultas de informações e muito mais. Digite `/` na caixa de entrada para acionar o preenchimento de comandos — a lista de candidatos é filtrada em tempo real conforme você continua digitando; aliases (apelidos) de comandos também são correspondidos.

Após digitar o nome completo do comando, pressione `Enter` para executar. Se a entrada com o prefixo `/` não corresponder a nenhum comando integrado ou de Skill, ela será enviada ao Agente como uma mensagem normal.

::: tip
Alguns comandos estão disponíveis apenas no estado ocioso (idle). Executar esses comandos enquanto uma sessão está transmitindo saída (streaming) ou compactando o contexto será bloqueado — pressione `Esc` ou `Ctrl-C` para interromper primeiro. A coluna "Sempre disponível" nas tabelas abaixo indica os comandos que também estão disponíveis durante o streaming.
:::

## Conta e Configuração

| Comando | Alias | Descrição | Sempre disponível |
| --- | --- | --- | --- |
| `/login` | — | Seleciona uma conta ou plataforma e faz login: o Kimi Code usa o fluxo de código de dispositivo OAuth; a Plataforma Kimi usa login por chave de API | Não |
| `/logout` | — | Limpa as credenciais da conta atualmente selecionada | Não |
| `/provider` | — | Abre o gerenciador de provedores interativo para visualizar, adicionar e remover provedores configurados. Consulte [Plataformas e Modelos — `/provider` e gerenciamento de provedores](../configuration/providers.md#provider-—-interactive-provider-management) | Sim |
| `/model` | — | Alterna o modelo de LLM usado na sessão atual | Sim |
| `/secondary-model` | `/subagent-model` | Escolhe o modelo padrão para subagentes (escreve `[secondary_model] default_model`; consulte o [pool de modelos de subagentes](../configuration/config-files.md#subagent-model-pool)) | Sim |
| `/settings` | `/config` | Abre o painel de configurações dentro da TUI | Sim |
| `/experiments` | `/experimental` | Abre o painel de recursos experimentais | Sim |
| `/permission` | — | Seleciona um modo de permissão | Sim |
| `/editor` | — | Configura o editor externo iniciado por `Ctrl-G` | Sim |
| `/theme` | — | Alterna o tema de cores da interface do terminal | Sim |

## Gerenciamento de Sessão

| Comando | Alias | Descrição | Sempre disponível |
| --- | --- | --- | --- |
| `/new` | `/clear` | Inicia uma nova sessão, descartando o contexto atual | Não |
| `/sessions` | `/resume` | Navega pelas sessões históricas e alterna para / restaura uma delas | Não |
| `/tasks` | `/task` | Navega pela lista de tarefas em segundo plano | Sim |
| `/fork` | — | Faz um fork (bifurcação) de uma nova sessão a partir da atual, preservando todo o histórico da conversa; você permanece na sessão atual | Não |
| `/title [<text>]` | `/rename` | Sem argumentos, exibe o título da sessão atual; com um argumento, define um novo título (máx. 200 caracteres) | Sim |
| `/compact [<instruction>]` | — | Compacta o contexto da conversa atual para liberar o uso de tokens; uma instrução personalizada opcional pode dar dicas ao modelo sobre o que preservar | Não |
| `/undo [<count>]` | — | Desfaz os prompts recentes do contexto ativo. Sem uma contagem, abre um seletor; com uma contagem, desfaz essa quantidade de prompts. Prompts anteriores à última compactação não podem ser desfeitos. Desfazer também reverte a lista de tarefas (todo list) e o estado do modo de plano produzidos por esses prompts (alterações de código não são revertidas) | Não |
| `/reload` | — | Recarrega a sessão atual e aplica as configurações mais recentes do `config.toml` (provedores, modelos, etc.) e as preferências de interface do `tui.toml`, sem reiniciar a CLI | Não |
| `/reload-tui` | — | Recarrega apenas as preferências de interface do `tui.toml` (tema, editor, notificações, etc.) sem reconstruir a sessão | Sim |
| `/init` | — | Analisa a base de código atual e gera o `AGENTS.md` | Não |
| `/export-md [<path>]` | `/export` | Exporta a sessão atual como um arquivo Markdown | Não |
| `/export-debug-zip` | — | Exporta a sessão atual como um arquivo ZIP de depuração (mesmo comportamento de [`kimi export`](./kimi-command.md#kimi-export)) | Não |
| `/copy` | — | Copia a última mensagem do assistente para a área de transferência | Não |
| `/add-dir [<path>]` | — | Adiciona um diretório de workspace extra à sessão atual. Execute sem um caminho (ou com `list`) para listar os diretórios configurados. Ao adicionar, escolha se deseja lembrar o diretório para o projeto em `.kimi-code/local.toml` | Não |
| `/web` | — | Abre a sessão atual na interface web (web UI): escolha um servidor em execução para se conectar ou inicie um novo servidor em primeiro plano após a saída da TUI. Consulte [`kimi web`](./kimi-command.md#kimi-web) | Sim |

## Modos e Controle de Execução

| Comando | Alias | Descrição | Sempre disponível |
| --- | --- | --- | --- |
| `/yolo` | `/yes` | Abre a lista de modos de permissão com "Perguntar Quando Necessário" (Ask When Needed) pré-selecionado; pressione `Enter` para confirmar. Neste modo, edições e comandos rotineiros são executados automaticamente; ações arriscadas, perguntas e planos ainda exigem confirmação | Sim |
| `/auto` | — | Abre a lista de modos de permissão com "Nunca Perguntar" (Never Ask) pré-selecionado; pressione `Enter` para confirmar. Neste modo, o Kimi nunca o interrompe; tudo é executado e decidido automaticamente | Sim |
| `/plan [on\|off]` | — | Alterna o modo Plano (Plan). Sem argumentos, inverte o estado atual; passar explicitamente `on`/`off` força a configuração. Simplesmente alternar não cria um arquivo de plano vazio | Sim |
| `/plan clear` | — | Limpa o plano atual | Não |
| `/swarm on\|off` | — | Ativa ou desativa o modo swarm (enxame) sem enviar um prompt. | Sim |
| `/swarm <task>` | — | Ativa o modo swarm e, em seguida, envia `<task>` como um prompt normal. Se o turno for concluído normalmente, o modo swarm será desativado automaticamente. No modo de permissão `manual`, o Kimi Code pergunta se deseja mudar para o modo "Perguntar Quando Necessário" ou "Nunca Perguntar" antes de iniciar. | Não |
| `/goal [...]` | — | Inicia ou gerencia um objetivo autônomo | Veja abaixo |

::: warning
O `/yolo` ignora a aprovação para chamadas de ferramentas regulares. Certifique-se de compreender os riscos potenciais antes de ativá-lo. A aprovação de saída do modo Plano não é ignorada pelo `/yolo`; o `Bash` dentro do modo Plano ainda está sujeito às regras regulares de permissão do `/yolo`.
:::

## Objetivo Autônomo (Autonomous Goal)

O `/goal` inicia ou gerencia o modo de objetivo: um objetivo persistente no qual o Kimi Code trabalha ao longo de turnos que continuam automaticamente. Para obter guias de uso e exemplos, consulte [Interação e entrada: Modo de objetivo](../guides/interaction.md#goal-mode).

```sh
/goal Atualize a documentação de checkout, execute a compilação da documentação e pare se ainda estiver bloqueado após 20 turnos
```

| Comando | Ação | Disponibilidade |
| --- | --- | --- |
| `/goal` ou `/goal status` | Exibe o objetivo atual juntamente com seu status, tempo decorrido, contagem de turnos e contagem de tokens | Sempre disponível |
| `/goal pause` | Pausa um objetivo ativo e o mantém | Sempre disponível |
| `/goal resume` | Retoma um objetivo pausado ou bloqueado | Apenas ocioso (Idle) |
| `/goal cancel` | Remove o objetivo atual | Sempre disponível |
| `/goal replace <objective>` | Substitui o objetivo salvo por um novo objetivo | Apenas ocioso |
| `/goal next <objective>` | Coloca um próximo objetivo na fila para esta sessão. Se nenhum objetivo estiver ativo, inicia-o imediatamente. O agente não vê os objetivos na fila até que o objetivo atual seja concluído | Sempre disponível |
| `/goal next manage` | Abre o gerenciador de próximos objetivos. Use <kbd>↑</kbd> / <kbd>↓</kbd> para navegar, <kbd>Space</kbd> para selecionar um objetivo para mover, selecione <kbd>↑</kbd> / <kbd>↓</kbd> para reordená-lo, <kbd>E</kbd> para editar, <kbd>D</kbd> para excluir e <kbd>Esc</kbd> para cancelar. No campo de edição, use <kbd>Shift-Enter</kbd> ou <kbd>Ctrl-J</kbd> para uma nova linha e <kbd>Enter</kbd> para salvar | Sempre disponível |

As palavras `status`, `pause`, `resume`, `cancel`, `replace` e `next` agem como subcomandos apenas quando são a primeira palavra após `/goal`. Se o seu objetivo precisar começar com uma dessas palavras, coloque `--` antes dela:

```sh
/goal -- cancelar a nota de lançamento antiga após a publicação da nova documentação
```

Se um próximo objetivo precisar começar com `manage`, coloque `--` após `next`:

```sh
/goal next -- gerenciar a checklist de lançamento
```

No modo de prompt não interativo, apenas as formas de criação iniciam o modo de objetivo:

```sh
kimi -p "/goal Corrigir o teste de checkout que está falhando"
```

O modo de prompt é encerrado com o código `0` quando o objetivo é concluído, `3` quando é bloqueado e `6` quando é pausado. Outros subcomandos `/goal`, incluindo `next`, são controles da TUI e não são suportados pelo `kimi -p`.

## Informações e Status

| Comando | Alias | Descrição | Sempre disponível |
| --- | --- | --- | --- |
| `/help` | `/h`, `/?` | Mostra os atalhos de teclado e todos os comandos disponíveis | Sim |
| `/btw [question]` | — | Abre uma conversa paralela em um subagente bifurcado (forked) sem afetar o turno atual do Agente principal; sem uma pergunta, abre o painel primeiro para aguardar a entrada | Sim |
| `/usage` | — | Mostra o uso de tokens, consumo de contexto e informações de cota | Sim |
| `/status` | — | Mostra o estado atual de execução da sessão: versão, modelo, diretório de trabalho, modo de permissão, etc. | Sim |
| `/mcp` | — | Lista os servidores MCP e seus status de conexão na sessão atual | Sim |
| `/plugins` | — | Abre o gerenciador de plugins interativo | Sim |
| `/version` | — | Exibe o número da versão da CLI do Kimi Code | Sim |
| `/feedback` | `/bug` | Envia feedback com logs de diagnóstico opcionais e contexto da base de código | Sim |

## Sair

| Comando | Alias | Descrição | Sempre disponível |
| --- | --- | --- | --- |
| `/exit` | `/quit`, `/q` | Sai da CLI do Kimi Code | Não |

## Comandos de Skill integrados

A CLI do Kimi Code vem com um conjunto de Skills integradas que aparecem diretamente como comandos slash `/<name>`. Diferente das Skills externas, elas não exigem o prefixo `skill:` e estão disponíveis nativamente.

| Comando | Descrição |
| --- | --- |
| `/mcp-config` | Configura servidores MCP e lida com o login OAuth do MCP. Consulte [MCP](../customization/mcp.md) |
| `/custom-theme [<text>]` | Cria ou edita um tema de cores personalizado para a TUI. Consulte [Temas](../customization/themes.md) |
| `/update-config` | Inspeciona ou edita o `config.toml` (modelo, provedor, permissão, hooks) e `tui.toml` (tema, editor, notificações, atualização automática) |
| `/check-kimi-code-docs` | Responde a perguntas sobre o produto Kimi Code (uso da CLI, configuração, assinatura, códigos de erro) com base na documentação oficial |
| `/import-from-cc-codex` | Importa instruções, skills e configurações de MCP do Claude Code e Codex para o Kimi Code |
| `/sub-skill` | Descobre e reorganiza o inventário local de skills em pacotes hierárquicos de sub-skills. Inclui `/sub-skill.review` (proposta somente leitura) e `/sub-skill.consolidate` (aplica a reorganização) |

Todos os comandos de Skills integradas estão disponíveis apenas no estado ocioso.

## Comandos Dinâmicos de Skill

Skills externas ativadas são registradas automaticamente como comandos slash. Skills externas comuns usam o prefixo de namespace `skill:`:

```
/skill:<nome> [texto extra]
```

Por exemplo, `/skill:code-style` carrega a Skill chamada `code-style` e a envia ao Agente; qualquer texto anexado após o comando é concatenado ao prompt da Skill.

Sub-skills externas aparecem diretamente no painel de comandos slash com nomes separados por pontos:

```
/<skill-pai>.<sub-skill> [texto extra]
```

Por exemplo, uma Skill filha chamada `review` dentro de uma Skill pai chamada `code-style` é exibida como `/code-style.review`. O nome do comando pontilhado é derivado da hierarquia; o `SKILL.md` filho pode manter seu `name` local.

Por conveniência, os comandos de Skills externas também suportam uma forma abreviada que omite o prefixo `skill:` — `/<name>` — desde que o nome não seja ocupado por um comando slash do sistema. Ou seja, `/code-style` atua como um atalho para `/skill:code-style`.

Skills integradas fornecidas com a CLI do Kimi Code aparecem diretamente como `/<name>` no painel de comandos slash. Por exemplo, `/mcp-config` ajuda a configurar servidores MCP e a lidar com o login OAuth do MCP, e `/custom-theme [texto extra]` invoca o fluxo de trabalho de tema personalizado para criar ou editar um tema para a TUI.

::: info
Comandos de Skills externas inseridos enquanto o agente está ocupado são enfileirados atrás do turno em execução em vez de serem rejeitados — pressione `Ctrl-S` para direcionar um comando enfileirado para o turno em execução imediatamente. Skills do tipo `flow` também são expostas via `/skill:<name>` — não há um namespace `/flow:` separado.
:::

Para instalar e criar Skills, consulte [Skills do Agente](../customization/skills.md).

## Próximos passos

- [Atalhos de Teclado](./keyboard.md) — Referência rápida para operações de teclado da TUI
- [Ferramentas Integradas](./tools.md) — Referência completa das ferramentas que o Agente pode chamar