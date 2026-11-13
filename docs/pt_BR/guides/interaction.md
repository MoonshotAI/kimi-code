# Interação e entrada de dados

A Kimi Code CLI funciona como uma TUI (interface de usuário em terminal) interativa, estruturada em torno de três componentes: a caixa de entrada, a visualização da conversa e a barra de status. Esta página aborda como inserir texto, colar mídias, navegar pelo fluxo de aprovação e alternar entre modos.

## Noções básicas sobre a caixa de entrada

A caixa de entrada aceita texto livre. Pressione `Enter` para enviar, ou `Shift-Enter` / `Ctrl-J` para inserir uma quebra de linha. Quando a caixa de entrada estiver vazia, use as setas `↑` / `↓` para navegar pelo histórico de entradas do diretório de trabalho atual, incluindo comandos de shell executados anteriormente.

**Como sair da CLI**: pressione `Ctrl-D` com a caixa de entrada vazia, pressione `Ctrl-C` duas vezes enquanto o sistema estiver ocioso, ou digite `/exit`. Pressionar `Ctrl-C` ou `Esc` durante a geração de uma resposta (streaming) interrompe a interação atual — isso não encerra o programa.

## Colagem de imagens e vídeos

A Kimi Code CLI permite colar imagens e vídeos diretamente na caixa de entrada. Assim, você pode discutir capturas de tela, protótipos de interface (UI), diagramas de arquitetura ou demonstrações de código sem precisar fazer upload ou converter arquivos previamente.

**A entrada de vídeos é um diferencial da Kimi Code** — você pode colar um videoclipe e solicitar que o modelo analise seu conteúdo, o fluxo da interface ou uma explicação passo a passo de um código.

Como colar:

- **macOS / Linux**: `Ctrl-V`
- **Windows**: `Alt-V`

Após colar, a caixa de entrada exibirá um espaço reservado, placeholder, que pode ser editado como um texto comum; ao enviar, esse espaço reservado é substituído pelo conteúdo real. Se o conteúdo na área de transferência for apenas texto simples, a operação funcionará como uma colagem convencional. O suporte a mídias depende das capacidades multimodais do modelo em uso (`image_in` / `video_in`); esse recurso é habilitado por padrão quando você está conectado a uma conta Kimi Code.

Caso uma conversa acumule mais de 20 MB de mídias, as imagens e os vídeos mais antigos serão removidos automaticamente das solicitações, e um aviso será exibido quando isso ocorrer.

## Comandos de barra (slash commands)

Digite `/` para abrir o menu de preenchimento automático — ele filtra as opções conforme você digita. A tecla `Esc` fecha o menu, e qualquer texto que não corresponda a um comando é enviado ao agente como uma mensagem comum. Comandos comuns:

| Comando | Ação |
| --- | --- |
| `/new` | Iniciar uma nova sessão |
| `/sessions` | Explorar e retomar sessões anteriores |
| `/compact` | Compactar o contexto da sessão atual |
| `/undo` | Desfazer prompts recentes |
| `/model` | Alternar o modelo utilizado na sessão atual |
| `/plan` | Alternar o modo de planejamento (planejar primeiro, depois executar) |
| `/yolo` | Abrir a lista de modos de permissão com a opção "Perguntar quando necessário" (Ask When Needed) pré-selecionada (edições e comandos de rotina são executados automaticamente) |
| `/goal` | Iniciar ou gerenciar o modo de objetivos (goal mode) |
| `/help` | Exibir todos os comandos |

As [Habilidades do Agente](../customization/skills.md) (Agent Skills) ativas também são registradas como comandos de barra (por exemplo, `/skill:<nome>`). Para conferir a lista completa, consulte a [Referência de comandos de barra](../reference/slash-commands.md).

## Referências a arquivos

Digite `@` para acionar o preenchimento automático de caminhos de arquivo; o caminho selecionado é inserido de forma relativa, e o agente carrega o conteúdo do arquivo diretamente ao ler sua mensagem.

- **Onde funciona**: tanto em diretórios que utilizam Git quanto nos que não utilizam; caminhos ocultos são incluídos, mas o diretório `.git` é excluído.
- **Sugestões de pastas**: terminam com `/`, permitindo que você continue completando caminhos dentro delas.
- **Mecanismo de contingência (fallback)**: enquanto o recurso de busca rápida ainda está sendo carregado, o Kimi Code recorre a uma verificação básica do sistema de arquivos.

> Referências com `@` e comandos iniciados por `/` são mecanismos distintos: o `@` fornece ao agente o contexto de um arquivo, enquanto o `/` aciona funcionalidades nativas ou "Skills" (habilidades).

## Fluxo de aprovação

Quando o agente chama uma ferramenta que gera efeitos colaterais — como modificar arquivos ou executar comandos —, a interface de terminal (TUI) exibe um painel de aprovação para sua confirmação.

- **Aprovar**: selecione usando as teclas de seta e pressione `Enter`, ou pressione `1`, `2` ou `3` para escolher diretamente.
- **Rejeitar**: pressione `Esc`, `Ctrl-C` ou `Ctrl-D`.
- **Aprovar para esta sessão**: aprova automaticamente chamadas do mesmo tipo durante o restante da sessão atual.
- **Regras permanentes**: adicione permissões (permitir/negar) nos [arquivos de configuração](../configuration/config-files.md#permission).

As aprovações não são solicitadas para chamadas de ferramentas comuns no modo "Ask When Needed" (perguntar quando necessário), nem para gravações em arquivos de plano no modo "Plan" (planejamento).

### Os três modos de permissão

O modo **"Sempre perguntar"** (anteriormente chamado de "Manual") é o padrão: operações de apenas leitura são executadas automaticamente, enquanto todas as outras ações — editar arquivos, executar comandos — exigem sua confirmação, uma a uma. Utilize-o quando desejar controle total sobre cada alteração.

O modo **"Perguntar quando necessário"** (anteriormente chamado de "YOLO"), ativado pelo comando `/yolo`, aprova automaticamente chamadas de ferramentas rotineiras, sendo ideal para tarefas em lote que você sabe serem seguras. Ele ainda solicita confirmação antes de ações sensíveis — como acessar arquivos confidenciais (ex.: `.env` ou chaves SSH), executar comandos perigosos (ex.: `shutdown` ou `rm -rf`) ou sair do modo "Planejamento" — e o agente ainda pode lhe fazer perguntas.

O modo **"Nunca perguntar"** (anteriormente chamado de "Automático"), ativado pelo comando `/auto", é um modo totalmente autônomo: a aprovação de todas as ferramentas é feita automaticamente, incluindo o acesso a arquivos sensíveis e a saída do modo "Planejamento". O agente não lhe faz perguntas — ele decide tudo por conta própria. O mecanismo de proteção contra comandos perigosos solicita sua confirmação antes da execução de comandos como `shutdown`, `reboot` ou `rm -rf` nos modos "Sempre perguntar" e "Perguntar quando necessário"; já no modo "Nunca perguntar", esses comandos são executados sem interrupção.


## Alternância entre modos

### Modo "Planejamento"

No modo "Planejamento" (Plan mode), o agente apresenta um plano de ação e aguarda sua aprovação antes de modificar qualquer arquivo — recurso útil para tarefas complexas ou de alto risco.

- Alternar: `Shift-Tab` ou `/plan`
- Limpar o plano atual: `/plan clear` (disponível apenas quando o agente estiver ocioso)

Após elaborar um plano, o agente faz uma pausa para sua análise — você pode aprová-lo, rejeitá-lo ou solicitar revisões. A saída do modo "Planejamento" exige sua confirmação, mesmo que o modo "Perguntar quando necessário" esteja ativo. A exceção é o modo "Nunca perguntar": nele, a saída do modo "Planejamento" é aprovada automaticamente e registrada como "Aprovado automaticamente" (Auto-approved) no histórico.

### Modo Shell

O modo Shell permite executar comandos de terminal sem sair da conversa. A saída do comando é inserida no contexto da conversa, permitindo que o agente visualize os resultados em interações posteriores.

- Entrar: digite `!` em uma caixa de entrada vazia ou cole um comando que comece com `!`.
- Sair: pressione `Backspace` ou `Esc` em uma caixa de entrada vazia; ao enviar um comando, você também retorna automaticamente ao modo normal.
- Executar em segundo plano: enquanto um comando estiver em execução, pressione `Ctrl+B` para movê-lo para uma tarefa em segundo plano.
- Recuperar comandos anteriores: com a caixa de entrada vazia no modo Shell, pressione `↑` para navegar pelos comandos executados anteriormente; ao recuperar um comando, você permanece no modo Shell, permitindo executá-lo novamente.
- Saídas extensas: quando a saída de um comando for muito longa, o card de resultado é recolhido automaticamente; pressione `Ctrl+O` para expandi-lo ou recolhê-lo (juntamente com a saída de ferramentas).

No modo Shell, a caixa de entrada exibe um prompt `!` à esquerda e a borda assume a cor violeta. Por exemplo, você pode executar `!gh auth login` para fazer login na CLI do GitHub sem precisar abrir um novo terminal, permitindo que o Kimi utilize o `gh` posteriormente.

### Modo Objetivo (Goal mode)

Um objetivo (goal) mantém o agente trabalhando em prol de um resultado definido ao longo de várias interações — enquanto um prompt comum indica o que deve ser feito em seguida, um objetivo define o estado final que deve ser alcançado. Utilize `/goal` para tarefas que possuam um ponto de conclusão claro e evidências verificáveis, como corrigir um conjunto de testes com falha ou investigar a causa de uma falha em um processo de build. Para edições pontuais ou perguntas que exigem uma resposta única, um prompt comum costuma ser mais adequado.

Descreva o objetivo após o comando `/goal`, especificando o resultado final e a condição de conclusão (limite de 4000 caracteres; entradas que excedam esse limite serão rejeitadas e permanecerão na caixa de entrada para edição):

```sh
/goal Corrigir todos os bugs de regressão no checkout, adicionar ou atualizar testes para cada correção e, em seguida, executar a suíte de testes de checkout.
```

Evite objetivos muito amplos, como `/goal encontrar todos os bugs nesta base de código` — sem critérios de sucesso definidos, o agente pode interromper a tarefa imediatamente ou trabalhar por um período muito mais longo do que o esperado. Metas claramente impossíveis (como `/goal prove que 1 + 1 = 3`) são marcadas imediatamente como bloqueadas.

Comandos de gerenciamento comuns:

| Comando | Ação |
| --- | --- |
| `/goal` ou `/goal status` | Exibe o objetivo atual e seu progresso |
| `/goal pause` / `/goal resume` | Pausa / retoma o objetivo |
| `/goal cancel` | Cancela o objetivo (solicita confirmação; um objetivo cancelado não pode ser retomado) |
| `/goal replace <objective>` | Substitui o objetivo atual |
| `/goal next <objective>` | Adiciona um objetivo à fila, que começará assim que o atual for concluído |

Um objetivo pode ser encerrado de três formas: **concluído** — alcançado, finalizado e resumido; **pausado** — pausado por você, por uma interrupção durante um turno ou devido a um erro; **bloqueado** — o agente não consegue prosseguir conforme definido e apresenta uma breve explicação do motivo. O limite de tempo (orçamento de tempo) é contabilizado apenas enquanto o objetivo está ativo e a sessão está aberta; encerrar a sessão ou pausar o objetivo interrompe essa contagem. Ao usar `/goal resume` após reabrir a sessão, a execução continua com o tempo restante.

Na interface web, a barra de objetivos abaixo da conversa permite pausar, retomar ou cancelar o objetivo diretamente. Clique nela para expandir os detalhes, incluindo o progresso do orçamento (como o limite de tokens, caso esteja configurado).

Use `/goal next <objective>` para agendar tarefas subsequentes sem interromper o objetivo atual. Objetivos na fila permanecem invisíveis para o agente até que o objetivo em curso seja concluído; em seguida, o primeiro da fila é iniciado automaticamente. O comando `/goal next manage` abre um gerenciador interativo para reordenar, editar ou excluir objetivos na fila (use as setas para navegar, a tecla `Espaço` para selecionar, `E` para editar, `D` para excluir e `Esc` para cancelar). Objetivos na fila nunca são iniciados enquanto o objetivo atual estiver pausado, cancelado ou bloqueado.

> Dica: no modo de permissão `manual`, um objetivo pode ser interrompido para aguardar a aprovação de ferramentas. O modo não interativo (non-interactive) permite apenas a criação de objetivos (`kimi -p "/goal ..."`) — retornando o código de saída `0` em caso de conclusão, `3` se bloqueado e `6` se pausado.

## Durante a exibição de resultados (streaming)

A caixa de entrada permanece utilizável enquanto o agente está processando (pensando) ou utilizando ferramentas, e oferece suporte às seguintes ações adicionais:

- **`Ctrl-S`**: insere o conteúdo da caixa de entrada no turno em execução imediatamente, sem aguardar a conclusão do processo atual.
- **`Esc` / `Ctrl-C`**: interrompe o turno em execução.
- **`Ctrl-O`**: alterna, de forma global, entre os estados expandido e recolhido dos resultados de ferramentas e dos resumos compactados.

Quando o agente está aguardando a conclusão de tarefas em segundo plano (por meio de `WaitFor`), o envio de uma mensagem (via `Enter` ou `Ctrl-S`) faz com que essa mensagem seja processada, encerrando a espera antecipadamente; mensagens que já estavam na fila no momento em que a espera começou também são processadas. Se a fila contiver um comando de shell ou uma "habilidade" (skill), tanto a fila quanto a nova entrada permanecerão aguardando até que o turno seja concluído. As tarefas em segundo plano continuam sendo executadas, e os resultados de ferramentas já obtidos são preservados. Caso existam outras ferramentas em execução no mesmo lote, o agente processará sua mensagem após o retorno dessas ferramentas.

## Editor externo

Pressione `Ctrl-G` para enviar o conteúdo atual da entrada para um editor externo. Ao salvar e fechar, o texto é inserido de volta na caixa de entrada; se você fechar sem salvar, o conteúdo original é preservado. Isso é útil quando você precisa inserir grandes blocos de texto ou conteúdos com formatação complexa.

Prioridade do editor: configuração `/editor` → variável de ambiente `$VISUAL` → variável de ambiente `$EDITOR`. Se nenhuma dessas opções estiver definida, execute `/editor` primeiro para escolher um editor padrão.

## Próximos passos

- [Atalhos de teclado](../reference/keyboard.md) — tabela de referência rápida com todos os atalhos
- [Comandos de barra (slash commands)](../reference/slash-commands.md) — todos os comandos nativos, com descrições e aliases
- [Sessões e contexto](./sessions.md) — como retomar sessões, comprimir o contexto e exportar conversas