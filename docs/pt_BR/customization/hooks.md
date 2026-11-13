# Hooks

Hooks são um mecanismo de gatilho automático: você informa o Kimi Code CLI com antecedência de que "quando X acontecer, execute este script." O script é executado em sua máquina local, e você pode incluir qualquer lógica nele. Típicos casos de uso: 

- **Intercepção de segurança**: Antes de o Agente executar um comando de shell, verifica-se se ele contém operações perigosas (como `rm -rf`) e a execução é bloqueada caso isso ocorra
- **Notificações na área de trabalho**: Quando uma tarefa em segundo plano é concluída, uma notificação do sistema é exibida para que você possa analisar os resultados
- **Verificações automáticas**: Sempre que o usuário envia uma mensagem, informações de contexto em segundo plano (como a branch atual do Git) são anexadas automaticamente

## Como Hooks Funcionam

Configurar uma regra de hook exige especificar três coisas: **qual evento aciona a regra**, **quais alvos devem corresponder** e **qual script deve ser executado**.

Quando acionada, a CLI empacota os detalhes do evento (motivo do acionamento, nome da ferramenta, conteúdo do comando, etc.) em formato JSON e os transmite ao seu script via **entrada padrão** (stdin). O script lê essas informações e decide como responder.

A resposta do script é determinada por dois fatores:

- **Código de saída**: `0` significa permitir, `2` significa bloquear; outros valores diferentes de zero resultam em permissão por padrão.
- **Saída padrão** (stdout): pode incluir texto explicativo.

Mesmo que o script apresente erro ou exceda o tempo limite, a CLI **não interromperá seu trabalho** em decorrência disso. Esse design de "permitir em caso de falha" é conhecido como fail-open, evitando que erros nos hooks se tornem impedimentos.

::: Nota de aviso
Justamente devido ao comportamento fail-open, os hooks são adequados para alertas e interceptações leves, mas **não devem ser utilizados como a única barreira de segurança**. Para operações de alto risco, utilize aprovações de permissão e confirmação manual.
:::

## Início Rápido: Um Hook Mínimo

O seguinte hook exibe uma notificação na barra de título do terminal sempre que uma tarefa em segundo plano é concluída (o macOS requer a instalação do `terminal-notifier`):

```toml
# Gravado em ~/.kimi-code/config.toml
[[hooks]]
event = "Notification"           # Gatilho: quando o status de uma tarefa em segundo plano muda
matcher = "task\\.completed"     # Considera apenas notificações de "conclusão"
command = "terminal-notifier -title Kimi -message 'Task done'"
```

Salve a configuração, inicie uma nova sessão e uma notificação aparecerá na próxima vez que uma tarefa em segundo plano for concluída.

## Configuração
 
 Todas as regras de *hook* são definidas no array `[[hooks]]` do arquivo `~/.kimi-code/config.toml`, onde cada entrada corresponde a uma regra:

 | Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `event` | `string` | Sim | Nome do evento gatilho; deve ser um dos eventos listados na [referência de eventos](#event-reference) |
| `matcher` | `string` | Não | Expressão regular para filtrar alvos do evento; se omitido, corresponde a todos |
| `command` | `string` | Sim | Comando de shell a ser executado quando o gatilho for acionado |
| `timeout` | `integer` | Não | Tempo limite em segundos, intervalo de 1 a 600; padrão de 30 segundos |

`[[hooks]]` permite apenas estes quatro campos; campos extras farão com que o carregamento do arquivo de configuração falhe.

**Quando múltiplas regras correspondem ao mesmo evento**, todos os hooks correspondentes são executados em paralelo; múltiplas regras com valores de `command` idênticos são executadas apenas uma vez.

O diretório de trabalho para os comandos dos hooks é o diretório do projeto da sessão atual.

<details>
<summary>Grupo de processos e tratamento de tempo limite</summary>

Em plataformas que não sejam Windows, os processos de hook são executados em um grupo de processos separado; ao ocorrer um timeout, a CLI primeiro envia um sinal para dar ao script a oportunidade de realizar a limpeza e, em seguida, encerra o processo à força.

</details>

### Formato de Dados de Evento

Sempre que um hook é acionado, a CLI passa as seguintes informações básicas para o script via stdin:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "session_title": "Fix the login page",
  "client_type": "kimi_code_cli",
  "cwd": "/path/to/project"
}
```

Eventos específicos também incluirão campos adicionais (como nome da ferramenta e conteúdo do comando); consulte a [referência de eventos](#event-reference). Todos os nomes de campos utilizam snake_case.

## Valores de Retorno

Após a execução do script ser encerrada, a CLI determina a intenção do hook com base no código de saída:

| Código de saída | Significado | Comportamento da CLI |
| --- | --- | --- |
| `0` | Saída normal, permitir | Continua a execução; o conteúdo do `stdout` (se houver) pode ser anexado ao contexto |
| `2` | Bloqueio intencional | Interrompe a operação atual; o conteúdo do `stderr` (impresso via `console.error`) é usado como o motivo do bloqueio |
| Outro (não zero) | Erro de script | Permissão padrão (fail-open) |
| Timeout ou falha crítica | Exceção no script | Permissão padrão (fail-open) |

Você também pode retornar um objeto JSON via stdout para o bloco:

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Por favor, use rg em vez de grep"
  }
}
```

::: info Quais eventos permitem bloqueio?
Apenas **eventos bloqueáveis** (`PreToolUse`, `Stop`, `UserPromptSubmit`) possuem valores de retorno que afetam o fluxo principal. Todos os outros são **eventos apenas de observação**: eles são disparados sem esperar resposta, e o fluxo principal não é afetado, independentemente do que o script retornar.
:::

## Referência de Evento

| Evento | Correspondência do Matcher | Suporta bloqueio? | Descrição |
| --- | --- | --- | --- |
| `UserPromptSubmit` | O texto enviado pelo usuário | ✓ | Acionado quando o usuário envia uma mensagem; o texto retornado é anexado ao contexto; o bloqueio pula a chamada do modelo nesta rodada |
| `UserPromptQueued` | O texto do prompt na fila | — | Acionado quando uma mensagem é colocada na fila enquanto uma rodada ainda está em execução; o payload inclui `prompt_id`, `prompt`, `queue_length` |
| `PreToolUse` | Nome da ferramenta | ✓ | Acionado antes de uma chamada de ferramenta (antes das verificações de permissão); a ferramenta não será executada se bloqueada |
| `Stop` | String vazia | ✓ | Acionado quando o modelo está prestes a encerrar a rodada; se bloqueado, uma mensagem pode ser anexada para permitir que o modelo continue |
| `TurnStarted` | Tipo de origem da rodada (e.g. `user`, `task`, `system_trigger`) | — | Acionado quando uma nova rodada começa; o payload inclui `turn_id`, `origin_kind`, `origin_name`, `prompt` |
| `PostToolUse` | Nome da ferramenta | — | Acionado após a execução bem-sucedida de uma ferramenta |
| `PostToolUseFailure` | Nome da ferramenta | — | Acionado após uma ferramenta falhar ou ser bloqueada |
| `PermissionRequest` | Nome da ferramenta | — | Acionado logo antes de aguardar a aprovação do usuário |
| `PermissionResult` | Nome da ferramenta | — | Acionado após a conclusão da aprovação |
| `SessionStart` | `startup` ou `resume` | — | Acionado após o início ou a retomada de uma sessão; o payload inclui `source`, `model`, `profile` |
| `SessionEnd` | `exit` ou `archive` | — | Acionado após o encerramento de uma sessão; `archive` indica que a sessão foi arquivada em vez de encerrada |
| `SessionHeartbeat` | String vazia | — | Acionado a cada 60 segundos enquanto a sessão estiver ativa; o temporizador é executado apenas quando este evento está configurado; o payload inclui `uptime_ms` |
| `SubagentStart` | Nome do subagente | — | Acionado antes de um subagente começar a ser executado |
| `SubagentStop` | Nome do subagente | — | Acionado após a conclusão bem-sucedida de um subagente |
| `TaskStarted` | Tipo de tarefa (`agent`, `process` ou `question`) | — | Acionado quando uma tarefa em segundo plano é iniciada; o payload inclui `task_id`, `description`, `detached` |
| `StopFailure` | Tipo de erro | — | Acionado após a falha do turno atual devido a um erro |
| `Interrupt` | String vazia | — | Acionado quando o usuário interrompe o turno (e.g. pressionando Esc); não é disparado em casos de timeout ou interrupções programáticas; ocorre no lugar de `Stop`; o payload inclui `reason` |
| `PreCompact` | `manual` ou `auto` | — | Acionado antes do início da compactação de contexto; valores de retorno são totalmente ignorados |
| `PostCompact` | `manual` ou `auto` | — | Acionado após a conclusão da compactação de contexto |
| `Notification` | Tipo de notificação (e.g. `task.completed`) | — | Acionado quando o status de uma tarefa em segundo plano é alterado |

## Exemplo: Bloqueio de comandos de shell perigosos

O seguinte hook verifica o conteúdo do comando antes de o Agente chamar a ferramenta `Bash` e o bloqueia caso `rm -rf` seja detectado:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/block-dangerous-bash.mjs"
timeout = 5
```

```js
// block-dangerous-bash.mjs
// Lê os dados do evento passados ​​pela CLI a partir da entrada padrão stdin
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input); // Analisa os dados do evento
  const command = payload.tool_input?.command ?? '';

  if (command.includes('rm -rf')) {
    // Explica o motivo do bloqueio via stderr; o código de saída 2 significa bloqueio
    console.error('Comando perigoso detectado, bloqueado');
    process.exit(2);
  }
  // Saída normal (código de saída 0) significa permissão
});
```

Após o bloqueio, a Kimi Code CLI grava o motivo do bloqueio de volta no contexto, e o modelo pode utilizá-lo para escolher uma alternativa mais segura.

::: Nota de aviso
Este exemplo demonstra apenas o mecanismo de bloqueio e não é um analisador de segurança adequado para ambientes de produção. Cenários reais são melhor atendidos pelo uso de whitelists ou de um analisador de shell dedicado para lidar com aspas, expansão de variáveis ​​e sequências de múltiplos comandos.
:::

## Next steps

- [Configuração](#configuration) — Referência completa dos campos para `[[hooks]]` no `config.toml`
- [Agentes e subagentes](./agents.md) — Use o evento `SubagentStop` para disparar notificações após a conclusão de um subagente