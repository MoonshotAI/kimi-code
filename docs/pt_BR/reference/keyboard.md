# Atalhos de Teclado

O modo interativo TUI do Kimi Code CLI suporta um conjunto de atalhos de teclado. Os atalhos são organizados em grupos por contexto de uso: entrada geral, troca de modo, durante o streaming, controle de saída de ferramentas, painel de aprovação e navegação em pop-ups. Digite `/help` na TUI a qualquer momento para abrir a referência de atalhos integrada.

## Atalhos Gerais

As seguintes teclas estão sempre disponíveis na caixa de entrada:

| Atalho | Função |
| --- | --- |
| `Enter` | Enviar a entrada atual |
| `Shift-Enter` / `Ctrl-J` | Inserir uma quebra de linha na entrada |
| `↑` / `↓` | Navegar pelo histórico de entrada |
| `Esc` | Fechar um pop-up / cancelar o preenchimento / interromper a saída de streaming ou a compactação de contexto |
| `Ctrl-C` | Interromper a saída de streaming atual, ou limpar a caixa de entrada |
| `Ctrl-D` | Sair do Kimi Code CLI quando a caixa de entrada estiver vazia |
| `Ctrl-T` | Expandir ou recolher a lista de tarefas (todo list) quando estiver truncada |
| `Ctrl-P` | Página anterior no painel experimental de Atualizações (Updates) quando houver várias páginas |
| `Ctrl-N` | Próxima página no painel experimental de Atualizações (Updates) quando houver várias páginas |

Pressionar `Ctrl-C` **durante o streaming** cancela imediatamente — não é necessária uma segunda confirmação.

**Sair do programa** (pressionar `Ctrl-C` com uma caixa de entrada vazia, ou pressionar `Ctrl-D`) usa um mecanismo de confirmação de duplo clique: após o primeiro pressionamento, um prompt aparece na barra de status; um segundo pressionamento da mesma tecla efetivamente encerra o programa. Pressionar qualquer outra tecla no meio do processo limpa o estado de confirmação.

## Troca de Modo

| Atalho | Função |
| --- | --- |
| `Shift-Tab` | Alternar para o modo de Planejamento (Plan mode) |
| `!` | Entrar no modo shell (em uma caixa de entrada vazia) |

Pressione `Shift-Tab` para ativar ou desativar o modo de Planejamento. Quando ativado, o Agente prioriza ferramentas de leitura para pesquisa e planejamento e pode escrever no arquivo de plano atual; o `Bash` está sujeito ao modo de permissão atual e às regras normais, sem nenhuma aprovação separada adicional acionada pelo modo de Planejamento. O simples fato de alternar os modos não cria um arquivo de plano vazio. Pressione `Shift-Tab` novamente para sair do modo de Planejamento.

Digite `!` em uma caixa de entrada vazia para entrar no modo shell e executar comandos de terminal diretamente; enquanto um comando estiver em execução, pressione `Ctrl+B` para movê-lo para uma tarefa em segundo plano (background task). Consulte [Interação e entrada](../guides/interaction.md#shell-mode).

## Entrada e Edição

| Atalho | Função |
| --- | --- |
| `Ctrl-G` | Editar a entrada atual em um editor externo |
| `Ctrl-V` | Colar uma imagem ou vídeo da área de transferência (Unix / macOS) |
| `Alt-V` | Colar uma imagem ou vídeo da área de transferência (Windows) |
| `Ctrl--` | Desfazer |
| `Esc` `Esc` | Abrir o seletor de desfazer (pressionar duas vezes enquanto ocioso) |

Pressionar `Ctrl-G` abre um editor externo, selecionado de acordo com a seguinte prioridade:

1. O editor configurado por meio do comando `/editor`
2. A variável de ambiente `$VISUAL`
3. A variável de ambiente `$EDITOR`

Após salvar e sair, o conteúdo editado substitui a caixa de entrada; sair sem salvar deixa a entrada inalterada.

Ao colar uma imagem ou vídeo, um espaço reservado (placeholder) é mostrado na caixa de entrada — os dados de mídia reais são enviados ao modelo quando a mensagem é enviada. A área de transferência do sistema é lida primeiro; no Linux, o Wayland e o X11 são testados; no WSL, o PowerShell também é usado como alternativa para ler a área de transferência do Windows.

## Durante o Streaming

Enquanto a saída de streaming estiver ativa, a caixa de entrada ainda pode receber entradas e suporta as seguintes operações adicionais:

| Atalho | Função |
| --- | --- |
| `Ctrl-S` | Direcionar (Steer): injetar a entrada atual diretamente no turno em execução |
| `Esc` | Interromper a saída de streaming atual |
| `Ctrl-C` | Interromper a saída de streaming atual |

Pressionar `Ctrl-S` faz com que o modelo veja sua mensagem no próximo ponto de interrupção, sem esperar que o turno atual termine.

## Saída de Ferramentas

| Atalho | Função |
| --- | --- |
| `Ctrl-O` | Expandir ou recolher a saída da ferramenta, a saída do comando shell e os resumos de compactação |

Quando houver resultados de chamadas de ferramentas ou saídas de comandos shell recolhidos no histórico, pressione `Ctrl-O` para alternar entre as visualizações recolhidas e expandidas. Após a compactação, o mesmo atalho mostra ou oculta o resumo da compactação no bloco respectivo.

## Painel de Aprovação

Quando o Agente inicia uma chamada de ferramenta que requer confirmação, a TUI exibe um painel de aprovação. Para o fluxo de trabalho de aprovação completo, consulte [Interação e Entrada](../guides/interaction.md#approval-flow). As teclas disponíveis dentro do painel são:

| Atalho | Função |
| --- | --- |
| `↑` / `↓` | Mover o cursor entre as opções candidatas |
| `Enter` | Confirmar a opção selecionada no momento |
| `1` ~ `9` | Selecionar diretamente a opção no índice correspondente |
| `Esc` / `Ctrl-C` / `Ctrl-D` | Rejeitar a solicitação atual |
| `Ctrl-E` | Expandir ou recolher o conteúdo completo quando o painel contiver um diff ou visualização de arquivo |
| `Ctrl-O` | Alternar o estado recolhido de outras saídas de ferramentas |

As opções que exigem feedback (como "Rejeitar" ou "Revisar") mudam para um estado de entrada de feedback após a confirmação: digite o texto de feedback e pressione `Enter` para enviar; pressione `Esc` para sair da entrada de feedback e retornar à lista de candidatos.

## Modo Pop-up

Após abrir o painel de ajuda com `/help`, use as seguintes teclas para navegar e fechá-lo:

| Atalho | Função |
| --- | --- |
| `↑` / `↓` | Rolar uma linha por vez |
| `PageUp` / `PageDown` | Rolar 10 linhas por vez |
| `Esc` / `Enter` / `q` / `Q` | Fechar o painel |

## Próximos passos

- [Comandos de Barra (Slash Commands)](./slash-commands.md) — Referência rápida para os comandos de controle embutidos na TUI
- [Comando `kimi`](./kimi-command.md) — Referência completa das flags de inicialização e subcomandos