# Ferramentas Integradas (Built-in Tools)

As ferramentas integradas formam o conjunto de ferramentas fornecido pelo Kimi Code CLI junto ao seu motor principal — sem necessidade de instalação de um servidor MCP. O Agente seleciona e chama automaticamente essas ferramentas com base na tarefa em questão durante cada conversa; os usuários podem inspecionar os detalhes de cada chamada de ferramenta por meio da interface de aprovação.

Em comparação com as ferramentas MCP, as ferramentas integradas são gerenciadas diretamente pelo runtime, seu ciclo de vida está vinculado à sessão e nenhum processo externo é necessário. Ambas seguem o mesmo mecanismo de aprovação unificado: **ferramentas somente leitura** (como `Read`, `Grep`, `Glob`) são automaticamente permitidas por padrão, enquanto **ferramentas de gravação e execução** (como `Write`, `Edit`, `Bash`) requerem aprovação do usuário por padrão. No modo Ask When Needed (Perguntar Quando Necessário), a aprovação para chamadas de ferramentas regulares é ignorada; a aprovação para sair do modo de Planejamento (Plan mode) não é afetada.

## Ferramentas de Arquivo

As ferramentas de arquivo lidam com a leitura, gravação e pesquisa no sistema de arquivos local — a base para tarefas de análise e modificação de código.

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `Read` | Auto-permitido | Ler o conteúdo de um arquivo de texto |
| `Write` | Requer aprovação | Criar ou sobrescrever um arquivo |
| `Edit` | Requer aprovação | Substituição precisa de string |
| `Grep` | Auto-permitido | Pesquisa de texto completo com tecnologia ripgrep |
| `Glob` | Auto-permitido | Encontrar arquivos por padrão glob |
| `ReadMediaFile` | Auto-permitido | Ler um arquivo de imagem ou vídeo |

**`Read`** aceita um caminho de arquivo (`path`) além dos opcionais `line_offset` (número da linha inicial; valores negativos contam a partir do final), `column_offset` (posição baseada em zero na primeira linha de uma leitura regular), `n_lines` (número de linhas de origem solicitadas) e `max_chars` (máximo de caracteres no resultado, incluindo números de linha e status). Omitir `n_lines` lê em direção ao final do arquivo. O padrão é 100.000 caracteres, e as chamadas podem solicitar até 500.000; ambos os valores podem ser alterados na [configuração do `read`](../configuration/config-files.md#read). Caracteres e deslocamentos de coluna usam o comprimento da string do JavaScript no texto exibido, excluindo o prefixo do número da linha para deslocamentos de coluna: letras comuns e caracteres chineses contam como um, enquanto muitos emojis contam como dois.

O `Read` prefere linhas completas e seus resultados não são encurtados novamente pelo limite geral de saída da ferramenta. Uma linha que não cabe inteira em sua própria página é retornada em fragmentos; o status relata o intervalo de colunas e os argumentos de `Next Read` (Próxima Leitura) para recuperar o restante sem aumentar o orçamento. Junte os fragmentos da mesma linha sem adicionar uma quebra de linha. Uma linha parcial permanece no intervalo `n_lines` solicitado até que seu final seja retornado. Posições de coluna inválidas retornam um erro em vez de pular o conteúdo.

Leituras de cauda (tail reads) retornam as linhas completas mais recentes no intervalo solicitado primeiro. Se nenhuma linha completa couber, o resultado inclui argumentos `Next Read` futuros para o intervalo não lido; `column_offset` não pode ser combinado com um `line_offset` negativo. Posições de continuação referem-se ao conteúdo atual do arquivo, então inicie uma nova leitura se o arquivo mudar. Se uma leitura de cauda relatar que o arquivo mudou durante a leitura, tente novamente com o arquivo atualizado. Arquivos UTF-16 LE/BE de até 10 MiB são verificados com decodificação estrita primeiro. Se a decodificação falhar, o `Read` retorna o texto legível com sequências malformadas substituídas por ``, e cada página avisa que a decodificação teve perdas e o texto pode diferir do original. O aviso conta no orçamento de caracteres; um `` literal em um arquivo válido não o aciona. Use `ReadMediaFile` para imagens ou vídeos.

**`Write`** aceita `path`, `content` (conteúdo) e um `mode` (modo) opcional (`overwrite` ou `append`; o padrão é sobrescrever). Diretórios pai ausentes são criados automaticamente; o modo `append` (anexar) adiciona conteúdo ao final do arquivo sem adicionar automaticamente uma quebra de linha. Gravar em um arquivo existente — tanto no modo `overwrite` quanto `append` — exige um `Read` (leitura) anterior desse arquivo na sessão; a gravação é rejeitada se o arquivo tiver mudado no disco desde a última leitura, enquanto a criação de um novo arquivo é isenta.

**`Edit`** aceita `path`, `old_string` (o texto exato a ser substituído) e `new_string` (o texto de substituição). Por padrão, ele substitui apenas uma correspondência única; se o mesmo conteúdo aparecer várias vezes no arquivo, a ferramenta retorna um erro e sugere usar `replace_all: true`. `old_string` e `new_string` não devem ser idênticos. O arquivo de destino deve ter sido lido com `Read` anteriormente na sessão, e a edição é rejeitada se o arquivo mudou no disco desde essa leitura.

**`Grep`** invoca o ripgrep para pesquisar o conteúdo do arquivo, suportando expressões regulares (`pattern`), um caminho de pesquisa (`path`), filtragem por tipo de arquivo (`type`, ex: `ts`, `py`), filtragem glob (`glob`) e modo de saída (`output_mode`: `files_with_matches` / `content` / `count_matches`; o padrão é `files_with_matches`). O modo `content` suporta linhas de contexto (`-A`, `-B`, `-C`), correspondência sem distinção entre maiúsculas e minúsculas (`-i`), números de linha (`-n`, padrão true) e correspondência multilinha (`multiline`). Todos os modos suportam paginação com `offset` + `head_limit`; `head_limit` tem o padrão de 250 e `0` significa ilimitado. Arquivos confidenciais (como arquivos `.env` e chaves privadas) são automaticamente filtrados; defina `include_ignored=true` para pesquisar arquivos ignorados pelo `.gitignore`, embora arquivos sensíveis permaneçam filtrados.

**`Glob`** corresponde a arquivos em um diretório especificado (`path`; o padrão é o diretório de trabalho) por padrão glob (`pattern`). Os resultados são classificados por tempo de modificação em ordem decrescente, retornando 100 entradas por padrão. Ele respeita o `.gitignore`, `.ignore` e `.rgignore` por padrão; defina `include_ignored=true` para incluir arquivos ignorados, como saídas de compilação (build outputs), enquanto arquivos sensíveis permanecem filtrados. Padrões de chaves como `*.{ts,tsx}` são suportados e padrões de curinga abrangentes são permitidos.

Use `offset` (padrão 0) e `head_limit` (padrão 100) para paginar pelos caminhos correspondentes; o resultado fornece o próximo deslocamento (offset) quando houver mais correspondências disponíveis. Defina `head_limit: 0` para remover o limite de contagem de correspondências. O limite de caracteres ainda se aplica: as páginas terminam em um caminho completo e fornecem o próximo deslocamento quando necessário. Páginas grandes são salvas em um arquivo que o agente pode ler com `Read`. Cada chamada pesquisa o sistema de arquivos atual novamente, portanto, alterações de arquivos podem mudar os resultados entre as páginas. Tempos limite (timeouts), diretórios ilegíveis ou o limite de captura de saída ainda podem deixar a pesquisa incompleta; o resultado avisa sobre esses casos, e aumentar o deslocamento não pode recuperar caminhos não coletados.

**`ReadMediaFile`** envia uma imagem ou vídeo para o modelo como conteúdo multimodal. Ele aceita `path`, além de controles opcionais de detalhes da imagem, como `region` e `full_resolution`; o limite de tamanho do arquivo é de 100 MB. As leituras de imagem padrão são compactadas para os limites do modelo configurado. Se a compactação automática não conseguir atingir esses limites com segurança, a ferramenta retorna um erro sem enviar a imagem original e orienta o modelo a criar e ler uma cópia menor. A disponibilidade depende das capacidades de visão do modelo atual (`image_in` / `video_in`).

## Shell

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `Bash` | Requer aprovação | Executar um comando shell |

**`Bash`** é a ferramenta que exige mais permissões e também a de uso mais geral. Parâmetros:

- `command` (obrigatório): o comando shell a ser executado
- `cwd`: diretório de trabalho
- `timeout`: tempo limite em milissegundos; o padrão em primeiro plano (foreground) é 60 segundos, o máximo é de 5 minutos
- `run_in_background`: se deve ser executado como uma tarefa em segundo plano (background); tarefas em segundo plano assumem o padrão de 10 minutos (sem limite de tempo por padrão no modo de impressão `kimi -p`)
- `description`: descrição da tarefa em segundo plano; obrigatório quando `run_in_background=true`
- `disable_timeout`: se deve remover o limite de tempo para tarefas em segundo plano

O modo de primeiro plano bloqueia o turno atual até que o comando seja concluído ou o tempo limite seja atingido, e a TUI transmite o stdout e stderr para o cartão da ferramenta `Bash` em execução enquanto o comando ainda está ativo. Por padrão, um comando em primeiro plano que atinge seu tempo limite não é encerrado (killed) — ele continua em execução como uma tarefa em segundo plano (limitado pelo tempo de espera padrão de 600s para o background); para restaurar a opção de encerrar no tempo limite, defina [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) como `false` em `[background]`. O padrão de 600s para o segundo plano é configurável via [`bash_task_timeout_s`](../configuration/config-files.md#background) (`0` = sem limite de tempo) e, no modo de impressão (`kimi -p`), o padrão é sem limite. O modo em segundo plano retorna um ID de tarefa imediatamente e notifica automaticamente o Agente quando a tarefa for concluída. O stdin é sempre fechado — comandos interativos recebem um EOF imediatamente. Uma estratégia de encerramento em duas fases (SIGTERM → período de tolerância de 5 segundos → SIGKILL) garante uma limpeza confiável do processo quando uma tarefa é interrompida ou atinge seu tempo limite de background. No Windows, o Git Bash é usado por padrão.

## Ferramentas Web

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `WebSearch` | Auto-permitido | Pesquisa na web |
| `FetchURL` | Auto-permitido | Buscar o conteúdo de uma URL especificada |

**`WebSearch`** aceita uma `query` (termos de pesquisa). Requer que o host forneça uma implementação de pesquisa; quando não injetada, a ferramenta não aparece na lista de ferramentas.

**`FetchURL`** aceita um único parâmetro `url` e retorna o conteúdo da página. Para páginas HTML, o host extrai o texto do corpo em vez de retornar o HTML completo; páginas em texto simples ou Markdown são repassadas diretamente. Também requer uma implementação fornecida pelo host.

## Modo de Planejamento (Plan Mode)

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `EnterPlanMode` | Auto-permitido | Entrar no modo de Planejamento |
| `ExitPlanMode` | Auto-permitido (requer que o usuário confirme o plano) | Sair do modo de Planejamento e enviar o plano |

O modo de Planejamento (Plan mode) é um estado de trabalho restrito: uma vez ativado, o `Write` e o `Edit` ficam limitados a gravar apenas no arquivo do plano atual, e a ferramenta `TaskStop` é totalmente bloqueada. Todas as outras ferramentas (incluindo o `Bash`) ainda são governadas pelas regras de permissão atuais.

**`EnterPlanMode`** não aceita parâmetros; em caso de sucesso, retorna um guia de fluxo de trabalho e o caminho do arquivo do plano.

**`ExitPlanMode`** lê o arquivo do plano atual, apresenta o plano ao usuário para aprovação e, em seguida, sai do modo de Planejamento. O parâmetro opcional `options` permite que o Agente ofereça de 1 a 3 abordagens alternativas (cada uma com uma `label` e `description`; `label` com no máximo 80 caracteres) para o usuário escolher durante a aprovação. Os rótulos devem ser únicos e não podem usar palavras reservadas como `Approve`, `Reject`, `Reject and Exit` ou `Revise`.

## Gerenciamento de Estado

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `TodoList` | Auto-permitido | Gerenciar uma lista de tarefas a fazer |

**`TodoList`** mantém uma lista visível de subtarefas em operações de várias etapas; o estado é armazenado na sessão do Agente. O parâmetro `todos` aceita um array onde cada item tem um `title` e um `status` (`pending` / `in_progress` / `done`). Omitir `todos` consulta a lista atual; passar um array vazio a limpa.

## Ferramentas de Colaboração

As ferramentas de colaboração lidam com a coordenação entre Agentes, interação do usuário e invocação de Skills.

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `Agent` | Auto-permitido | Gerar um sub-Agente para executar uma subtarefa |
| `AgentSwarm` | Auto-permitido no modo swarm; caso contrário, requer aprovação | Iniciar subagentes baseados em itens ou retomar subagentes existentes |
| `AskUserQuestion` | Auto-permitido | Fazer uma pergunta ao usuário para coletar uma entrada estruturada |
| `NotifyUser` | Auto-permitido | Mostrar ao usuário uma breve atualização de progresso no meio do turno |
| `Skill` | Auto-permitido | Invocar uma Skill inline registrada |

**`Agent`** delega uma subtarefa a um sub-Agente. Parâmetros obrigatórios: `prompt` (descrição completa da tarefa) e `description` (um resumo curto de 3 a 5 palavras). Parâmetros opcionais: `subagent_type` (o padrão é `coder`), `resume` (ID de um Agente existente para retomar; mutuamente exclusivo com `subagent_type`), `run_in_background` (o padrão é falso) e `model` (disponível quando um [pool de modelos de subagentes](../configuration/config-files.md#subagent-model-pool) está configurado — seja uma tabela `[secondary_model.models]` ou um único `default_model`: um alias do pool, ou `"primary"` para o modelo que o próprio chamador está executando; ignorado ao retomar). Sem isso, o subagente vincula o `default_model` do pool; sem um pool configurado, os subagentes sempre herdam o modelo do chamador. As tarefas do agente expiram após 2 horas por padrão; o limite é configurável via `[subagent] timeout_ms` no `config.toml` (`0` = sem limite, ou a variável de ambiente `KIMI_SUBAGENT_TIMEOUT_MS`), e assume o padrão sem tempo limite no modo de impressão (`kimi -p`). No modo de primeiro plano, o Agente pai aguarda a conclusão do sub-Agente antes de continuar; no modo de segundo plano, um ID de tarefa é retornado imediatamente e o resultado é entregue automaticamente de volta ao Agente principal por meio de uma mensagem sintética do Usuário quando concluído. Quando várias chamadas `Agent` em primeiro plano são executadas na mesma etapa, a TUI as agrupa e mostra o status de cada subagente (em execução, aguardando, concluído ou com falha) junto com o tempo decorrido. Consulte [Agentes e Sub-Agentes](../customization/agents.md) para obter detalhes.

**`AgentSwarm`** inicia subagentes a partir de um `prompt_template` compartilhado e um array `items`, retoma subagentes existentes por meio de `resume_agent_ids`, ou combina ambos em uma única chamada. O template deve conter o marcador `{{item}}`; cada item substitui esse espaço reservado e inicia um novo subagente. Passe `subagent_type` para escolher o perfil usado por cada subagente gerado no enxame (swarm), ou omita para usar `coder`. Passe `model` (disponível quando um [pool de modelos de subagentes](../configuration/config-files.md#subagent-model-pool) está configurado — uma tabela `[secondary_model.models]` ou um único `default_model`) para executar subagentes gerados por item em um alias do pool ou no próprio modelo do chamador (`"primary"`). Sem isso, subagentes gerados por item vinculam o `default_model` do pool; sem um pool configurado, eles herdam o modelo do chamador. Subagentes retomados mantêm seu próprio modelo. Sem `resume_agent_ids`, a ferramenta requer pelo menos 2 itens; com `resume_agent_ids`, ela pode retomar um ou mais subagentes existentes. A ferramenta suporta um total de até 128 subagentes, espera que todos terminem e retorna um relatório agregado. Cada subagente tem um tempo limite de 2 horas por padrão; o limite é configurável via [`[swarm] timeout_ms`](../configuration/config-files.md#swarm) no `config.toml` (`0` = sem tempo limite, ou a variável de ambiente `KIMI_CODE_SWARM_TIMEOUT_MS`), e o padrão é sem tempo limite no modo de impressão (`kimi -p`). Um subagente que atingiu o tempo limite é abortado e marcado como com falha no relatório agregado. Na TUI, os swarms em primeiro plano mostram um painel de progresso `Agent swarm` ao vivo acima da caixa de entrada. Se uma resposta do modelo chamar `AgentSwarm`, essa chamada deve ser a única ferramenta na resposta; para executar vários swarms, chame um `AgentSwarm`, espere o resultado e chame o próximo, ou combine o trabalho em um swarm quando um único template puder cobri-lo. No modo de permissão `manual`, chamadas de `AgentSwarm` fora do modo swarm ativo solicitam aprovação, a menos que uma regra de permissão os permita; enquanto o modo swarm está ativo, o próprio `AgentSwarm` é auto-aprovado. Regras de permissão correspondem ao `AgentSwarm` apenas pelo nome da ferramenta — padrões de argumento como `AgentSwarm(swarm)` não são suportados. Por padrão, a ferramenta aumenta a simultaneidade sem um limite superior (5 subagentes começam imediatamente e, a seguir, mais 1 a cada 700 ms); defina `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` para um inteiro positivo para limitar quantos subagentes executam ao mesmo tempo durante esse crescimento, ou deixe sem definição para não ter limite. Se for definido com um valor que não é um inteiro positivo, a chamada AgentSwarm falhará rapidamente.

**`AskUserQuestion`** faz uma pergunta estruturada de múltipla escolha ao usuário — útil para desambiguação ou seleção de opções. O parâmetro `questions` aceita de 1 a 4 perguntas; cada pergunta requer `question` (terminando com `?`), `options` (de 2 a 4 escolhas, cada uma com um `label` e uma `description`) e um opcional `header` (máx 12 caracteres) e `multi_select` (o padrão é falso). Uma opção "Other" (Outro) é anexada automaticamente. Definir `background` como true inicia uma tarefa de pergunta em segundo plano e retorna um ID de tarefa imediatamente; a pergunta permanece aberta após o término do turno e a resposta é entregue ao Agente como uma notificação assim que o usuário responder. Quando o host não oferece suporte a questionamentos interativos, uma mensagem de falha é retornada e o Agente deve perguntar ao usuário diretamente em uma resposta de texto.

**`NotifyUser`** permite que o Agente principal e os subagentes enviem pequenas atualizações de progresso usando um único parâmetro `message` com formatação Markdown leve. O painel `Updates` (Atualizações) da TUI mantém todas as atualizações em ordem, incluindo mensagens múltiplas da mesma fonte. As mensagens dos subagentes exibem seu respectivo ID de agente existente, como `[agent-7]`, na mesma linha da mensagem. Mensagens do agente principal não possuem prefixo. Mensagens completas continuam disponíveis por paginação, em vez de serem substituídas por uma prévia de uma linha.

O painel, por padrão, exibe a página mais recente e agrupa as linhas de mensagens renderizadas a partir do final, até oito por página. Para dez atualizações de uma linha, a primeira página conterá duas e a última página conterá oito. Páginas curtas usam apenas o espaço de que seu conteúdo necessita. Pressione `Ctrl-P` para a página anterior e `Ctrl-N` para a próxima página. A paginação acontece no painel sem alterar o foco de entrada ou o rascunho, e para na primeira e última páginas em vez de dar a volta ciclicamente. Enquanto você lê páginas antigas, as novas atualizações anexadas mantêm os limites de página existentes e mostram uma contagem. Retornar à página mais recente preenche as atualizações a partir do final novamente e retoma o acompanhamento de novas atualizações. Quando há apenas uma página, essas teclas mantêm seu comportamento normal de editor.

Finalizar um turno deixa as mensagens e a página selecionada visíveis. O próximo turno do agente principal as limpa; os turnos filhos não limpam o painel. Novas sessões, o comando `/clear` ou a reabertura de uma sessão começam com o painel vazio. As atualizações aparecem apenas após o resultado de uma ferramenta confirmar sua exibição com sucesso; os fragmentos de argumento não são mostrados enquanto aguardam aprovação. Notificações que falharam, foram interrompidas ou suprimidas não entram no painel, e a transcrição preserva a indicação de se cada chamada exibiu uma atualização ou não. Descobertas importantes ainda devem estar na resposta final ou na entrega final do subagente (handoff).

Todo esse recurso é experimental e desativado por padrão. Habilite-o com `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER=1`, `[experimental] notify_user = true` no arquivo `config.toml`, ou usando `/experiments` antes de criar uma sessão na TUI. Sessões criadas enquanto o recurso estiver desativado não possuem a ferramenta nem as orientações do prompt.

Sessões existentes mantêm a disponibilidade da ferramenta de notificação e o seu prompt inalterados, mesmo após serem reabertas. Desativar o recurso oculta o painel e desativa os atalhos de paginação; qualquer chamada de `NotifyUser` já existente termina normalmente e relata que a atualização não foi exibida. Ligar novamente o recurso restaura a exibição para as sessões que já possuem a ferramenta. Se uma sessão foi criada com o recurso desativado, inicie uma nova sessão para usar as Atualizações. Mudar apenas esta flag pelo `/experiments` não recarrega a sessão.

**`Skill`** permite ao Agente invocar ativamente uma Skill registrada do tipo inline. Aceita `skill` (o nome da Skill) e um parâmetro opcional `args` (texto de argumento adicional). Apenas Skills com `type = "inline"` podem ser chamadas através dessa ferramenta; Skills com `disableModelInvocation: true` são rejeitadas. A profundidade máxima de aninhamento é de 3 níveis. Consulte [Skills de Agente](../customization/skills.md) para obter detalhes.

## Tarefas em Segundo Plano (Background Tasks)

Ferramentas de tarefas em segundo plano gerenciam tarefas iniciadas via `Bash`, `Agent` ou `AskUserQuestion`. Quando uma tarefa atinge um estado terminal, seu status e caminho de saída salva (ou, para perguntas, a própria resposta) são automaticamente entregues de volta ao Agente; use `TaskOutput` para checar o progresso antecipadamente, ou `WaitFor` para aguardar o resultado dentro do turno atual.

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `TaskList` | Auto-permitido | Listar tarefas em segundo plano |
| `TaskOutput` | Auto-permitido | Ver a saída de uma tarefa em segundo plano |
| `TaskStop` | Requer aprovação | Parar uma tarefa em segundo plano em execução |
| `WaitFor` | Auto-permitido | Aguardar o fim de tarefas em segundo plano |

**`TaskList`** retorna a lista de tarefas em segundo plano. Parâmetros opcionais: `active_only` (o padrão é verdadeiro; lista apenas tarefas em execução) e `limit` (o padrão é 20; faixa de 1–100).

**`TaskOutput`** retorna o status e a saída de uma tarefa com base em seu `task_id`. A pré-visualização inline inclui no máximo os últimos 32 KB de conteúdo; o log completo é salvo em disco, e a ferramenta também retorna um caminho `output_path` sugerindo usar o `Read` para acesso paginado. A chamada é sempre não bloqueante — retorna a captura instantânea atual imediatamente, e a conclusão da tarefa é entregue por meio de uma notificação automática.

**`TaskStop`** aceita um `task_id` e um parâmetro opcional `reason` (motivo, o padrão é `Stopped by TaskStop`). É seguro chamar em tarefas que já estão em um estado terminal.

**`WaitFor`** suspende o turno atual até que uma tarefa em segundo plano termine, o tempo limite expire ou uma mensagem de direcionamento (steer) chegue. Parâmetros: `timeout` (obrigatório, em segundos, máx 600) e o opcional `task_id`. Sem um `task_id`, a espera termina assim que qualquer tarefa de background que estava rodando no momento da chamada termina; quando nenhuma tarefa em segundo plano está rodando, ela retorna imediatamente. O tempo limite esgotado não é um erro — o resultado lista as tarefas ainda em execução, e o Agente pode esperar de novo ou fazer outro trabalho enquanto isso. O direcionamento (comando Steer via `Ctrl-S` no terminal) finaliza a espera antes do tempo; as tarefas em segundo plano continuam a executar e ainda notificam o agente ao terminarem. Uma tarefa cujo resultado foi reportado pelo `WaitFor` não produzirá mais uma notificação automática de conclusão.

## Tarefas Agendadas (Scheduled Tasks)

As ferramentas de tarefas agendadas permitem ao Agente reinjetar um prompt na sessão atual em um momento futuro — seja como um lembrete único ou como uma tarefa recorrente acionada por cron (verificações periódicas, relatórios diários, monitoramento de implantação, etc.). Os agendamentos ficam vinculados à sessão e continuam ativos quando você a retoma com `kimi --session`, mas não são levados para uma sessão inteiramente nova. Uma única sessão pode comportar no máximo 50 tarefas agendadas ativas. Defina `KIMI_DISABLE_CRON=1` para desativá-las totalmente; veja as [Variáveis de Ambiente](../configuration/env-vars.md#runtime-switches).

| Ferramenta | Aprovação Padrão | Descrição |
| --- | --- | --- |
| `CronCreate` | Requer aprovação | Agendar um prompt para ser acionado em um momento futuro |
| `CronList` | Auto-permitido | Listar tarefas agendadas |
| `CronDelete` | Requer aprovação | Cancelar uma tarefa agendada |

**`CronCreate`** aceita `cron` (uma expressão cron padrão de 5 campos no fuso horário local do usuário: `minuto hora dia-do-mês mês dia-da-semana`), `prompt` (o texto a ser injetado quando disparado; limite UTF-8 de 8 KB) e um parâmetro opcional `recurring` (o padrão é `true`; passe `false` para um lembrete único que se auto-deleta após disparar). Ao obter sucesso, retorna um `id` de 8 dígitos hexadecimais, um `humanSchedule` (formato legível para humanos, ex: `every 5 minutes`) e o `nextFireAt` (o timestamp ISO para o momento em que ocorrerá a próxima execução).

Para evitar que todos os usuários façam chamadas ao mesmo tempo no início de uma hora, o agendador aplica uma perturbação (jitter) determinística: tarefas recorrentes são deslocadas para frente por `min(10% do período, 15 minutos)`; tarefas únicas que recaem exatamente sobre os minutos `:00` ou `:30` são movidas para a frente em até 90 segundos a mais. Se o agendador perder vários gatilhos de tempo (por exemplo, porque o notebook estava em repouso), ele dispara apenas uma vez ao despertar — o prompt é envolvido em um envelope `<cron-fire>` com uma contagem coalescente `coalescedCount`. Tarefas recorrentes que estiverem vivas por mais de 7 dias disparam uma última vez com a variável `stale="true"` (obsoleto) e em seguida são automaticamente apagadas; chame `CronCreate` novamente para mantê-las ativas.

**`CronList`** é uma ferramenta somente leitura que não aceita parâmetros. Ela retorna um registro por tarefa ativa com os campos: `id`, `cron`, `humanSchedule`, `nextFireAt`, `recurring`, `ageDays` e `stale`. Os registros são separados por `---` e organizados em ordem de execução.

**`CronDelete`** aceita um único `id`. Para tarefas recorrentes, todas as execuções futuras param imediatamente; para tarefas únicas, a execução agendada pendente é cancelada. Tarefas únicas que já dispararam são auto-excluídas, logo, a chamada de `CronDelete` numa tarefa que já rodou retorna `No cron job with id ...` (Nenhum trabalho cron com id ...). A deleção é irreversível — utilize o `CronCreate` novamente para restaurar. O `CronDelete` também é bloqueado no modo de Planejamento (Plan mode).

## Próximos passos

- [Agentes e Sub-Agentes](../customization/agents.md) — Mecânica de agendamento e isolamento de contexto para a ferramenta `Agent`
- [Hooks](../customization/hooks.md) — Acionar scripts locais antes e depois das chamadas de ferramentas
- [Comandos de Barra (Slash Commands)](./slash-commands.md) — Referência rápida para os comandos de controle embutidos na TUI