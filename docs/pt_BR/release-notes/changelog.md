---
outline: 2
---

# Changelog

Esta página documenta as alterações em cada versão do Kimi Code CLI.

## 2.1.1 (2026-09-24)

### Melhorias

- Reverter os observadores do sistema de arquivos para arquivos de configuração e workspace, deixando-os ativados por padrão novamente. Defina `[watch] enabled` como `false` ou `KIMI_CODE_WATCH=0` para mantê-los desativados. Consulte [`watch`](../configuration/config-files.md#watch) para mais detalhes.

### Correções de bugs

- Reverter algumas das alterações excessivamente defensivas da versão 2.1.0.

## 2.1.0 (2026-09-23)

### Funcionalidades

- Adicionar uma opção experimental para alternar o modo de tela cheia da TUI. Ative-a pela configuração de modo da TUI em `/settings` ou defina `tui_mode = "fullscreen"` em `~/.kimi-code/tui.toml`; a alteração entra em vigor após reiniciar o Kimi Code.
- No modo de tela cheia, clicar em um bloco recolhido permite expandi-lo ou recolhê-lo.
- Adicionar um indicador clicável "Ir para o final" à TUI em tela cheia.

### Melhorias

- Reduzir o tempo de inicialização e o uso de memória da CLI.
- Desativar por padrão os observadores do sistema de arquivos para arquivos de configuração e workspace. Defina `[watch] enabled` como `true` ou `KIMI_CODE_WATCH=1` para reativá-los. Consulte [`watch`](../configuration/config-files.md#watch) para mais detalhes.

### Correções de bugs

- Reforçar a segurança do workspace: impedir que ferramentas de arquivos acessem arquivos fora do diretório de trabalho por meio de links simbólicos, aplicar configurações locais do projeto somente após o workspace ser considerado confiável, impedir que a configuração Git do repositório execute comandos durante operações Git em segundo plano e rejeitar diretórios adicionais que apontem para o diretório pessoal ou para a raiz do sistema de arquivos.
- Corrigir vários problemas conhecidos e implementar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver mais detalhes técnicos.

## 2.0.2 (2026-09-19)

### Melhorias

- O agente não presume mais que o diretório de trabalho atual seja a raiz do projeto.

### Correções de bugs

- Corrigir falhas na compactação após a troca para um modelo com uma janela de contexto menor.
- Corrigir mensagens novas que, ocasionalmente, apareciam em uma posição antiga da conversa após retomar uma sessão.
- Corrigir mensagens enviadas enquanto o agente estava em execução que, às vezes, apareciam duplicadas no chat.
- web: Aprimorar as interações e corrigir problemas conhecidos.

## 2.0.1 (2026-09-18)

### Melhorias

- Remover a regra do prompt do sistema que proibia todo acesso a arquivos fora do diretório de trabalho.
- Os provedores podem ler suas chaves de API de uma variável de ambiente nomeada por meio de [`api_key_env`](../configuration/providers.md) no `config.toml`.
- Impedir que os observadores de arquivos do workspace examinem uma raiz de projeto sem limites e adicionar `[watch] enabled` / `KIMI_CODE_WATCH` para desativar completamente a observação. Consulte [`watch`](../configuration/config-files.md#watch) para mais detalhes.
- Deixar de solicitar aprovação para comandos Bash que não podem ser analisados estaticamente no modo de permissão Ask When Needed.
- Renomear o subcomando `kimi install-app` para `kimi install-desktop`; o nome antigo continua funcionando como um alias oculto.

### Correções de bugs

- Corrigir vários problemas conhecidos e implementar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver mais detalhes técnicos.

## 2.0.0 (2026-09-17)

### Funcionalidades

- Adicionar o comando slash `/desktop` (alias `/install-desktop`) e o subcomando `kimi install-app`.
- Renderizar blocos de código Mermaid como diagramas no terminal. Desative esse recurso em `/settings` → Mermaid diagrams ou defina `mermaid = "off"` na seção `[markdown]` do `tui.toml`.

### Melhorias

- O plugin de navegador integrado agora aparece como "Kimi Browser Extension" no painel de plugins, no catálogo do marketplace e na documentação, acompanhando a mudança de nome do produto.

### Correções de bugs

- Corrigir vários problemas conhecidos e implementar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver mais detalhes técnicos.

## 0.43.1 (2026-09-15)

### Funcionalidades

- Adicionar suporte nativo à área de transferência no Linux X11, para que copiar a partir da TUI não dependa mais do suporte OSC 52 do terminal.

### Aprimoramentos

- Reduzir travamentos do event loop e a sobrecarga do GC em sessões com muitos subagentes simultâneos.

### Correções de bugs

- Corrigir o comportamento em que pressionar Ctrl+C enquanto os subagentes estão em execução encerrava toda a CLI em vez de apenas interromper os subagentes.
- Corrigir a renderização progressivamente mais lenta a cada rodada de execuções grandes do AgentSwarm.
- Corrigir a memória que não era liberada quando os escopos dos subagentes eram descartados.
- Corrigir o modo tower que confundia agentes recém-criados com entradas do registro de agentes de sessões anteriores.
- Parar de retornar sessões excluídas na pesquisa global antes que o índice de pesquisa seja atualizado.
- Corrigir as cores dos links em tabelas Markdown com quebra de linha e a ordenação do preenchimento automático de arquivos com `@`.

## 0.43.0 (2026-09-14)

### Funcionalidades

- web: Os títulos de sessão gerados por IA agora estão sempre ativados — um título é gerado após o primeiro turno e pode ser regenerado pelo campo de renomear, sem necessidade de uma flag experimental.
- Excluir sessões pelo seletor de sessões: pressione Ctrl+X em uma sessão e, em seguida, y para confirmar.
- Adicionar `-y, --yes` ao `kimi upgrade` (alias `kimi update`) para ignorar a solicitação de confirmação e instalar a atualização diretamente.
- Adicionar a opção de configuração `loop_control.compaction_max_attempts` para definir o número máximo total de tentativas para uma solicitação de compactação com falha (padrão 5). Consulte [`loop_control`](../configuration/config-files.md#loop_control) para obter detalhes.

### Aprimoramentos

- Ignorar a solicitação de confirmação para comandos rm -rf que tenham como destino apenas caminhos `/tmp` ou `/temp`.
- Permitir que mensagens de direcionamento interrompam esperas por tarefas em segundo plano.
- Os limites de tempo dos objetivos não contabilizam mais o tempo em que a sessão permanece fechada, e o limite de 24 horas foi removido.
- Adicionar a variável de ambiente `KIMI_CODE_PERMISSION_MODE_REMINDER`: defina-a como `0` para impedir a injeção dos lembretes automáticos sobre o modo de permissão no contexto do modelo.

### Correções de bugs

- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.42.0 (2026-09-09)

### Funcionalidades

- O Remote Control agora está sempre ativado; a flag experimental `KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL` foi removida. Consulte [Remote Control](https://moonshotai.github.io/kimi-code/guides/remote-control.html) para mais detalhes.
- web: Suporte à exclusão permanente de sessões pelo menu de contexto da linha da sessão, com uma solicitação de confirmação.
- Adicionadas ferramentas somente leitura ao agente lateral `/btw`.
- web: Visualização de imagens e vídeos em uma barra de mídia reorganizável no compositor, permitindo mencioná-los no texto quando necessário e mantendo as visualizações após colocá-los na fila e enviá-los.
- Aceita imagens HEIC, HEIF e BMP em anexos de prompts e no `ReadMediaFile` quando o modelo é servido pelo Kimi.

### Aperfeiçoamentos

- Recolher chamadas de ferramentas concluídas na transcrição, mostrando apenas um cabeçalho e uma linha de resultado marcada: a saída curta é exibida por completo, enquanto a saída oculta é contabilizada (`N more lines`, `+N more`) e revelada por `Ctrl-O`, conforme indicado no rodapé enquanto estiver disponível.
- Atualizar o nível padrão de esforço de raciocínio para o nível recomendado para usuários elegíveis.
- O conjunto de modelos de subagentes (`[secondary_model]`) agora está sempre ativado; a flag experimental de modelo secundário e a opção de desativação `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL` foram removidas.
- Adicionar limites de caracteres configuráveis e leitura retomável de arquivos com linhas longas, sem truncamento repetido da saída; consulte [`read`](https://moonshotai.github.io/kimi-code/configuration/config-files.html#read) para mais detalhes.
- O modelo de leitura do índice de sessões do minidb e o worker de busca global agora estão sempre ativados; as flags experimentais foram substituídas pela seção de configuração `[database]` e pelas variáveis de ambiente `KIMI_CODE_PERSISTENCE_MINIDB_READMODEL` / `KIMI_CODE_SEARCH_WORKER`; consulte [`database`](https://moonshotai.github.io/kimi-code/configuration/config-files.html#database) para mais detalhes.

### Correções de bugs

- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.41.0 (2026-09-04)

### Funcionalidades

- web: Adicionar o modo de colaboração multiagente tower (experimental), ativado pelo comando `/tower` ou pelo menu de adição do compositor; `/tower` permite especificar uma branch base (por exemplo, `/tower add-new-feature`).
- web: Adicionar anotações de seleção — selecione um texto nas mensagens, nas visualizações de arquivos, no diff e nos painéis de alterações por turno, ou no terminal, para adicionar um comentário ou citá-lo no chat.
- CLI: Adicionar uma solicitação de avaliação da sessão que convida você a avaliá-la em momentos apropriados acima da caixa de entrada.

### Aperfeiçoamentos

- O modo de permissão automática não bloqueia mais comandos perigosos e comandos que não podem ser analisados estaticamente.
- Lembrar o modelo sobre seu orçamento de contexto antes da compactação automática e, após a compactação, direcioná-lo ao log de eventos da sessão para obter detalhes exatos.
- web: Renomear os três modos de permissão para Always Ask / Ask When Needed / Never Ask e atualizar suas descrições; ao alternar para o modo de permissão Ask When Needed ou Never Ask, agora é exibido um aviso de que os arquivos podem ser modificados ou excluídos diretamente nesse modo.

- web: A tecla Esc não fecha mais o painel de detalhes à direita.
- web: Reestilizar os comandos Bash no painel à direita para o estilo de terminal.
- Entregar as respostas de perguntas em segundo plano diretamente ao agente, em vez de por meio de um arquivo de saída salvo.
- As mensagens finais de subagentes com menos de 200 caracteres não são mais enviadas de volta para expansão.

### Correções de bugs

- Corrigir o modo de impressão (`kimi -p`) que perde os registros da sessão quando a execução é encerrada devido a um erro ou a um sinal de término.
- Corrigir o modo de impressão (`kimi -p`) que ignora a variável de ambiente `KIMI_DISABLE_TELEMETRY`.
- Modo tower (experimental): corrigir o modo tower que nunca era iniciado quando ativado por meio de `[experimental] tower = true` no config.toml em vez da variável de ambiente, e fazer `/tower` funcionar em diretórios que não são repositórios Git; os erros de ativação agora informam o bloqueador real.
- Corrigir o cancelamento das perguntas em segundo plano assim que o agente termina seu turno.
- Corrigir a retomada de um subagente por seu ID de agente depois que a sessão é reaberta em um novo processo; o subagente retomado segue o modo de permissão atual e é correspondido pelo seu próprio perfil nas regras de permissão.
- web: Corrigir as visualizações de alterações de arquivos por turno que exibiam linhas adicionadas/removidas que nunca existiram e contagens de linhas imprecisas quando o mesmo arquivo era editado várias vezes em um único turno; os cartões de alterações agora exibem apenas estatísticas exatas de linhas.
- web: Corrigir o nível padrão de esforço de raciocínio nas configurações, que não podia ser definido para o nível mais alto (Max).
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.40.1 (2026-09-02)

### Correções de bugs

- Corrigir a condição para exibição da solicitação de migração do kimi-cli.

## 0.40.0 (2026-09-02)

### Funcionalidades

- web: Adicionar um painel de Plugins às Configurações para navegar pelo marketplace de plugins e instalar, ativar, desativar e remover plugins.
- web: Permitir a ativação de múltiplas skills a partir de uma única mensagem.
- Adicionar o comando `kimi session list` para listar sessões pela linha de comando.
- Modo tower (experimental, `KIMI_CODE_EXPERIMENTAL_TOWER=1`): o agente não entra mais no modo tower por conta própria — ative-o com `/tower on` ou `/tower <base-branch>`.
- A configuração de modelo do subagente (`[secondary_model]`) passa de experimental para estável.
- Bloquear comandos de shell perigosos, como shutdown, reboot ou rm -rf, no modo Auto, e sempre perguntar antes de executá-los nos modos Manual e YOLO; desative a proteção com `[permission] dangerous_command_guard = false` ou `KIMI_CODE_DANGEROUS_COMMAND_GUARD=false`.

### Aperfeiçoamentos

- Preservar comentários, ordem das chaves e formatação no config.toml quando os valores de configuração forem atualizados.
- Remover a restrição do workspace sobre o parâmetro cwd da ferramenta Bash.
- Definir como padrão a opção "Trust this folder" na solicitação de confiança do workspace, em vez de "Don't trust".
- O subcomando `kimi acp` não respeita mais `KIMI_CODE_LEGACY_FLAG`; ele sempre é executado no mecanismo de agente padrão.
- web: Adicionar uma opção para alternar a quebra de linha ao painel de diff e simplificar seu cabeçalho.

### Correções de bugs

- Respeitar entradas de configuração `[experimental]` explícitas em vez do interruptor principal `KIMI_CODE_EXPERIMENTAL_FLAG`, de modo que uma flag definida como `false` no config.toml permaneça desativada; as variáveis `KIMI_CODE_EXPERIMENTAL_<NAME>` específicas de cada recurso ainda substituem ambas.
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.41.0 (2026-09-04)

### Funcionalidades

- web: Adicionar modo de colaboração entre múltiplos agentes do tower (experimental), habilitado por meio do comando `/tower` ou do menu de mais opções do compositor; `/tower` permite especificar uma branch base (por exemplo, `/tower add-new-feature`).
- web: Adicionar anotação de seleção — selecione um texto nas mensagens, nas pré-visualizações de arquivos, nos painéis de diff e de alterações por turno ou no terminal para adicionar um comentário ou citá-lo no chat.
- CLI: Adicionar um aviso de avaliação da sessão que convida o usuário a avaliá-la nos momentos apropriados acima da caixa de entrada.

### Aprimoramentos

- O modo de permissão automática não bloqueia mais comandos perigosos e comandos que não podem ser analisados estaticamente.
- Lembrar o modelo de seu limite de contexto antes da compactação automática e, após a compactação, direcioná-lo para o log de eventos da sessão para obter detalhes exatos.
- web: Renomear os três modos de permissão para Always Ask / Ask When Needed / Never Ask e atualizar suas descrições; ao mudar para o modo de permissão Ask When Needed ou Never Ask, agora é exibido um aviso de que os arquivos podem ser modificados ou excluídos diretamente nesse modo.
- web: Esc não fecha mais o painel de detalhes à direita.
- web: Reformular os comandos Bash no painel à direita no estilo de terminal.
- Entregar as respostas de perguntas em segundo plano diretamente ao agente, em vez de por meio de um arquivo de saída salvo.
- As mensagens finais do subagente com menos de 200 caracteres não são mais reenviadas para expansão.

### Correções de bugs

- Corrigir o modo de impressão (`kimi -p`) que perdia os registros da sessão quando a execução era encerrada devido a um erro ou a um sinal de término.
- Corrigir o modo de impressão (`kimi -p`) que ignorava a variável de ambiente `KIMI_DISABLE_TELEMETRY`.
- Modo tower (experimental): corrigir o modo tower que nunca era iniciado quando habilitado por meio de `[experimental] tower = true` no config.toml em vez da variável de ambiente, e fazer `/tower` funcionar em diretórios que não são repositórios Git; os erros de habilitação agora identificam o bloqueio real.
- Corrigir perguntas em segundo plano que eram canceladas assim que o agente terminava seu turno.
- Corrigir a retomada de um subagente por seu ID de agente depois que a sessão era reaberta em um novo processo; o subagente retomado segue o modo de permissão atual e é associado ao seu próprio perfil nas regras de permissão.
- web: Corrigir as pré-visualizações de alterações de arquivos por turno que exibiam linhas adicionadas/removidas que nunca existiram e contagens de linhas imprecisas quando o mesmo arquivo era editado várias vezes em um único turno; os cartões de alteração agora mostram apenas estatísticas exatas de linhas.
- web: Corrigir a configuração do nível de esforço de raciocínio padrão que não podia ser definida para o nível mais alto (Max).
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.40.1 (2026-09-02)

### Correções de bugs

- Corrigir a condição para exibir o aviso de migração do kimi-cli.

## 0.40.0 (2026-09-02)

### Funcionalidades

- web: Adicionar um painel de Plugins às Configurações para navegar pelo marketplace de plugins e instalar, habilitar, desabilitar e remover plugins.
- web: Permitir a ativação de várias skills a partir de uma única mensagem.
- Adicionar o comando `kimi session list` para listar sessões pela linha de comando.
- Modo tower (experimental, `KIMI_CODE_EXPERIMENTAL_TOWER=1`): o agente não entra mais no modo tower por conta própria — ative-o com `/tower on` ou `/tower <base-branch>`.
- A configuração do modelo de subagente (`[secondary_model]`) deixa de ser experimental e passa a ser estável.
- Bloquear comandos de shell perigosos, como shutdown, reboot ou rm -rf, no modo Auto, e sempre perguntar antes de executá-los nos modos Manual e YOLO; desabilite a proteção com `[permission] dangerous_command_guard = false` ou `KIMI_CODE_DANGEROUS_COMMAND_GUARD=false`.

### Aprimoramentos

- Preservar comentários, ordem das chaves e formatação no config.toml quando os valores de configuração forem atualizados.
- Remover a restrição do workspace sobre o parâmetro cwd da ferramenta Bash.
- Definir como padrão a opção "Trust this folder" na solicitação de confiança do workspace, em vez de "Don't trust".
- O subcomando `kimi acp` não respeita mais `KIMI_CODE_LEGACY_FLAG`; ele sempre é executado pelo mecanismo de agente padrão.
- web: Adicionar uma opção de quebra de linha de código ao painel de diff e simplificar seu cabeçalho.

### Correções de bugs

- Respeitar entradas explícitas de configuração `[experimental]` em vez da chave mestra `KIMI_CODE_EXPERIMENTAL_FLAG`, de modo que uma flag definida como `false` no config.toml permaneça desativada; as variáveis `KIMI_CODE_EXPERIMENTAL_<NAME>` específicas de cada recurso ainda substituem ambas.
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.39.1 (2026-08-28)

### Correções de bugs

- web: Corrigir a alteração do modo de permissão em uma sessão que modificava o modo de todas as sessões; o modo de permissão agora é específico para cada sessão.
- web: Corrigir usuários conectados sem um modelo utilizável que eram solicitados incorretamente a fazer login (e ficavam presos nessa tela na web); a etapa de envio agora oferece a opção de selecionar ou configurar um modelo.
- web: Corrigir o primeiro caractere do IME (ou teclado) que era silenciosamente perdido após clicar no espaço reservado do compositor.
- web: Corrigir anexos em uma sessão recém-criada que continuavam sendo exibidos como se estivessem sendo enviados após o upload ter sido concluído.
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.39.0 (2026-08-27)

### Funcionalidades

- Adicionar o Remote Control como um recurso experimental para acessar remotamente uma sessão web local. Habilite-o com `KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL=1` e, em seguida, execute `kimi rc`, `kimi web --remote-control` ou `/remote-control` para iniciá-lo.
- Adicionar o modo tower experimental para orquestração de múltiplos agentes; defina `KIMI_CODE_EXPERIMENTAL_TOWER=1` e, em seguida, execute `/tower on` e `/tower <objective>` para iniciá-lo.
- Adicionar um parâmetro opcional `fork` às ferramentas subagent e swarm, que inicia o subagente com um instantâneo do histórico de conversas do agente que o chamou; defina `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=1` ou `subagent_fork = true` em `[experimental]` no config.toml para habilitá-lo.
- web: Permitir mover um comando Bash ou subagente em primeiro plano em execução para segundo plano por meio do botão "Move to background" no cartão em execução.
- web: Adicionar uma aba flat/por workspace à lista de sessões para dispositivos móveis.
- Adicionar o plugin Tencent CloudBase ao marketplace selecionado.
- Adicionar uma opção de configuração dedicada `[swarm] timeout_ms` (ou a variável de ambiente `KIMI_CODE_SWARM_TIMEOUT_MS`) para os tempos limite dos subagentes do AgentSwarm, que não seguem mais `[subagent] timeout_ms`.

### Aprimoramentos

- web: Reformular a barra lateral direita como um painel com várias abas.
- web: Melhorar a interação do compositor, incluindo a apresentação de anexos de arquivos, pastas e mídia.
- web: Melhorar o estilo da interface de usuário para dispositivos móveis.

### Correções de bugs

- Corrigir as ferramentas de arquivos e os diretórios de trabalho do shell que falhavam ao resolver caminhos do Git Bash, como /c/Users ou /tmp no Windows.
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.38.0 (2026-08-20)

### Funcionalidades

- Suportar dois métodos de login OAuth — kimi.ai e kimi.com.
- Adicionar a ferramenta WaitFor: o agente agora pode aguardar a conclusão de uma tarefa em segundo plano durante o turno atual, em vez de encerrar o turno e ser reinvocado.
- Adicionar 13 fontes de dados ao plugin oficial Kimi Datasource — dados do governo chinês (NDA/NBS) e padrões (GB/HB/DB/TT), oito conjuntos de dados de organizações internacionais (WHO, FAO, UNSD, ECB, Eurostat, UNICEF, OECD, FRED), Xinhua Finance e Caixin. Atualize o plugin pela aba Official em /plugins.
- web: Adicionar uma ação Pin ao menu de mais opções do cabeçalho do chat.

### Aprimoramentos

- Edit e Write agora exigem a leitura de um arquivo existente antes de modificá-lo.
<!-- - Os subagentes não iniciam mais seus próprios subagentes por padrão; perfis de agentes personalizados ainda podem permitir isso explicitamente. -->
- Recolher a saída longa de comandos shell `!` em vez de inundar o histórico. Pressione ctrl+o para expandir ou recolher a saída junto com a saída da ferramenta.

### Correções de bugs

- Corrigir entradas do config.toml que eram perdidas quando o arquivo apresentava um erro de sintaxe ou era editado fora do aplicativo.
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.37.2 (2026-08-19)

### Aprimoramentos

- web: As Configurações agora possuem uma aba Lab com uma nova opção de alternância da barra lateral com várias abas; quando habilitada, a barra lateral exibe as abas Open / Done / Workspaces.
- Realizar diversos aprimoramentos e melhorias internas. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.37.1 (2026-08-18)

### Correções de bugs

- Corrigir imagens e vídeos colados que não conseguiam chegar ao modelo.

## 0.37.0 (2026-08-18)

### Funcionalidades

- Ativar várias skills em um único prompt. Digite `/` após um espaço em branco para inserir um token de skill.
- A CLI nativa do Windows (binário único) agora oferece suporte a atualizações automáticas.
- web: A barra lateral ganha as abas Open / Done / Workspaces, e as sessões podem ser marcadas como concluídas.
- web: Adicionar uma página de gerenciamento de sessões.

### Aprimoramentos

- Colocar na fila os comandos de skills iniciados com `/` enquanto o agente estiver ocupado, em vez de rejeitá-los.
- web: Arquivos, pastas e skills mencionados com @ nas mensagens do chat agora são exibidos como ícones em formato de pílula.
- web: O título da aba do navegador agora exibe o nome do diretório do workspace atual.
- web: A caixa de diálogo de pesquisa agora também encontra workspaces, e ao selecionar um resultado de workspace ou sessão, a barra lateral é expandida e o item é colocado em evidência por meio da rolagem.
- web: Renomear o painel Subagent para "Background Agent".
- Avisar quando um objetivo `/goal` digitado ultrapassar o limite de 4.000 caracteres e manter a entrada caso ela seja rejeitada.

### Correções de bugs

- Corrigir sessões de chamadas de ferramentas do Gemini que falhavam em solicitações subsequentes.
- web: Corrigir o Ctrl+K no compositor que abria a pesquisa de sessões no macOS — a pesquisa de sessões agora responde somente ao Cmd+K.
- web: Corrigir o painel Background Agent que exibia contagens e status de tarefas incorretos.
- web: Corrigir a falha ao colar uma pasta copiada no compositor, que causava um erro de conexão durante o upload — as pastas agora são ignoradas.
- Corrigir vários problemas conhecidos e realizar diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver entradas mais técnicas.

## 0.36.1 (2026-08-14)

### Recursos

- web: Gerar títulos de sessão com IA (experimental). Desativado por padrão — defina `KIMI_CODE_EXPERIMENTAL_AUTO_SESSION_TITLE=1` (ou a flag principal `KIMI_CODE_EXPERIMENTAL_FLAG=1`) para ativá-lo.

### Melhorias

- web: Aprimorar os controles de Plano, Objetivo e Enxame no compositor, que agora ficam no menu + ao lado da caixa de entrada.

### Correções de bugs

- Corrigir vários problemas conhecidos e fazer diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver mais detalhes técnicos.

## 0.36.0 (2026-08-13)

### Recursos

- Atualizar a configuração experimental do modelo de subagente para um pool de modelos: a seção `[secondary_model]` agora pode conter um conjunto de modelos candidatos com descrições, e o agente principal escolhe entre eles a cada inicialização com base na tarefa.

Defina `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1` (ou a flag principal `KIMI_CODE_EXPERIMENTAL_FLAG=1`) antes de iniciar o Kimi para ativá-lo.

Configurações recomendadas:

Mínima: execute `/secondary-model` na TUI ou escreva uma única linha `default_model` no `config.toml`, para fazer com que todos os subagentes usem o mesmo modelo por padrão; adicione `force = true` para fixar essa escolha, impedindo que o agente principal a substitua.

Declare um pool nomeado com uma descrição de uma linha para cada alias — as descrições são o que o agente principal vê ao fazer a escolha:

```toml
[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
[secondary_model.models]
"kimi-code/kimi-for-coding-highspeed" = "Fast and cheap — good for daily refactoring, code explanation, and small edits."
"kimi-code/k3" = "Strong at complex reasoning and deep debugging — pick it for hard problems."
```

Consulte a [documentação do pool de modelos de subagentes](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#subagent-model-pool) para mais detalhes.
- Adicionar um modo TUI experimental em tela cheia. Defina a variável de ambiente `KIMI_CODE_TUI_FULL_SCREEN=1` para ativá-lo.
- Suportar a renderização de fórmulas matemáticas em LaTeX (`$…$` / `$$…$$`) nas mensagens da TUI como fórmulas Unicode.

### Correções de bugs

- Mostrar os alvos de inicialização do MCP do projeto no aviso de confiança do workspace, definir como padrão a recusa de confiança e resolver os binários `fd` e `stty` para caminhos absolutos, para que workspaces não confiáveis não possam inserir executáveis com nomes simples antes da confirmação.
- Corrigir sessões que falhavam com um erro 400 do provedor em todas as solicitações seguintes após um turno ser interrompido enquanto o modelo ainda estava pensando, em provedores compatíveis estritamente com OpenAI (por exemplo, DeepSeek).
- Corrigir o Ctrl+C sendo ignorado durante novas tentativas automáticas de solicitações de API que falharam.
- Corrigir vários problemas conhecidos e fazer diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver mais detalhes técnicos.

## 0.35.0 (2026-08-12)

### Recursos

- Adicionar o plugin Modern Web Guidance ao marketplace de plugins incluído. Execute `/plugins` e selecione Modern Web Guidance para instalá-lo.
- Exibir o progresso de trabalho em tempo real dos subagentes em segundo plano no painel `/tasks`.

### Correções de bugs

- Corrigir subagentes coder que iniciavam outros subagentes por padrão.
- Corrigir as contagens de tokens informadas após a compactação que ficavam muito abaixo do tamanho real do contexto; agora elas correspondem aos números exibidos enquanto a sessão está em execução.
- Corrigir dois riscos de inserção de binários no Windows.
- Corrigir vários problemas conhecidos e fazer diversos aprimoramentos. Consulte o [changelog no GitHub](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md) para ver mais detalhes técnicos.

## 0.34.0 (2026-08-06)

### Recursos

- web: Adicionar uma visualização plana à lista de sessões da barra lateral.
- O plugin Kimi Computer Use agora oferece suporte ao Windows x64 — instale-o pelo `/plugins`.
- Exibir um lembrete de expiração do cache ao retomar ou enviar após um longo período de inatividade. Defina [`cache_expiry_hint`](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#tui-toml) como `false` para desativá-lo.

### Aprimoramentos

- web: As tarefas de subagentes exibem seu modelo e nível de raciocínio.
- web: Exibir um cartão de falha com opção de retomar com um clique quando uma solicitação ao modelo falhar.
- web: Exibir o progresso das tentativas (tentativa N de M) no status de execução durante novas tentativas automáticas.
- Exibir links da extensão do navegador e as etapas de ativação após instalar o Kimi WebBridge.

### Correções de bugs

- Corrigir arquivos de texto UTF-16 LE/BE (com ou sem BOM) que falhavam ao carregar.
- web: Corrigir anexos que eram descartados quando enviados com um comando de skill.
- web: Corrigir o seletor de modelos que ultrapassava os limites da tela quando muitos modelos estavam disponíveis.
- web: Corrigir um caminho de arquivo com espaços que abria a pasta Documentos em vez do arquivo no Windows.
- web: Corrigir o nível de raciocínio que era redefinido para o padrão do modelo quando uma nova sessão era iniciada com um comando de skill.
- web: Corrigir sessões canceladas manualmente que exibiam um marcador de erro na barra lateral; agora ele aparece somente quando o último turno falha.
- web: Corrigir a composição de IME ao renomear uma sessão — Enter e Esc não atuam mais durante a composição.
- web: Corrigir o arraste para selecionar texto durante a renomeação que movia o item inteiro da lista.
- web: Corrigir os indicadores de tarefas em segundo plano e todos que pulavam para o topo quando a caixa de diálogo de aprovação do plano era expandida.
- web: Corrigir a direção do chevron no botão "mostrar menos" do cartão de resumo de arquivos alterados.
- Corrigir o kimi -p que era encerrado antes que as tarefas em segundo plano e os subagentes terminassem.
- /feedback agora funciona para usuários conectados em qualquer modelo; usuários desconectados veem a página de cadastro e os links do GitHub Issues.
- Corrigir a remoção de um servidor MCP que quebrava sessões abertas: suas ferramentas continuam visíveis, mas as chamadas falham com um aviso de remoção.
- Corrigir o resultado do último turno que era perdido após reinicializações do servidor — turnos com falha agora continuam marcados nas listas de sessões e nas sessões retomadas.
- Corrigir sessões retomadas que exibiam a conclusão de tarefas em segundo plano como texto bruto do protocolo em vez de um cartão de status.

## 0.33.0 (2026-08-05)

### Recursos

- Adicionar o Kimi Computer Use e o Kimi WebBridge como entradas oficiais integradas do marketplace na CLI v2. A instalação pelo `/plugins` configura o runtime gerenciado e o plugin mais recentes, informa etapas manuais incompletas e permite tentar novamente uma configuração interrompida.
- web: Adicionar e gerenciar provedores personalizados nas configurações.
- web: Fixar sessões no topo da barra lateral.
- web: Definir um emoji para o título da sessão.
- web: Exibir a conta conectada e o uso do plano.
- Adicionar `/bug` como um alias para o comando slash `/feedback`. Digite `/bug` para enviar feedback.

### Aprimoramentos

- Perguntar se o usuário confia na pasta atual durante a inicialização.
- `/fork` não muda mais para a sessão criada a partir do fork: a sessão atual permanece ativa e suas tarefas em segundo plano continuam em execução. Encontre o fork em `/sessions`.
- web: Reformular a interface e a experiência do usuário (UI/UX) e corrigir problemas conhecidos.
- Iniciar a TUI interativa sem criar uma sessão.
- Renomear a aba do marketplace de plugins parceiros para Curated e esclarecer que ela contém plugins de terceiros dos parceiros da Kimi.

### Correções de bugs

- Corrigir todas as chamadas de ferramentas que falhavam com spawn EBADF no macOS quando uma pasta de skill continha uma árvore de arquivos muito grande.
- Corrigir a reautorização OAuth do MCP que sempre falhava com "Invalid redirect URI"; o registro de cliente antigo agora é descartado e recriado com a URI de callback atual.
- Garantir que a primeira solicitação aguarde a conclusão da inicialização do MCP enquanto a interface continua sendo aberta imediatamente.
- Os resultados das ferramentas MCP agora disponibilizam ao modelo o campo `structuredContent` definido pela especificação e os metadados do servidor `_meta`, em vez de descartá-los silenciosamente, para que servidores que retornam seu contrato legível por máquina nesses campos funcionem da mesma forma que em outros hosts MCP.
- Corrigir a disponibilidade dos recursos integrados e o status de instalação em `/plugins`, preservar as skills legadas do WebBridge como backups durante as atualizações e impedir que as atualizações do Computer Use dupliquem ou desconectem servidores MCP.

### Refatorações

- Executar as interfaces da CLI (TUI interativa, `kimi -p`, `kimi acp`, `kimi export`, `kimi provider`) no mecanismo agent-core-v2 por padrão. Defina `KIMI_CODE_LEGACY_FLAG=1` para voltar ao mecanismo legado.

## 0.32.0 (2026-08-04)

### Recursos

- Adicionar quatro eventos de hook: `TurnStarted`, `UserPromptQueued`, `TaskStarted` e `SessionHeartbeat`. Configure-os em `[[hooks]]` no `config.toml` — consulte [Hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks.html) para mais detalhes.

### Aprimoramentos

- Renomear duas chaves de `[loop_control]`: `max_retries_per_step` → `max_attempts_per_step` e `max_steps_per_run` → `max_steps_per_turn`; as chaves antigas deixam de funcionar e exibem um aviso sobre a renomeação na inicialização — consulte [loop_control](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#loop-control).
- Adicionar uma seção de configuração `[token_counting]`: quando um provedor não informar o uso de tokens, alternar a exibição do tamanho do contexto para estimativas locais — consulte [token_counting](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#token-counting).

### Correções de bugs

- Corrigir respostas a prompts de perguntas interativas que eram rejeitadas quando o provedor do modelo retornava IDs de chamadas de ferramentas contendo dois-pontos (alguns gateways compatíveis com OpenAI).
- Corrigir a compactação automática do contexto que ficava presa tentando novamente uma solicitação grande demais até falhar.
- Usar como alternativa o snapshot integrado do catálogo models.dev quando o catálogo público estiver inacessível, para que a importação de um provedor conhecido continue funcionando offline ou em redes bloqueadas.
- Corrigir o limite da janela de contexto que era exibido como 0 quando nenhum modelo estava configurado; agora ele usa o modelo padrão como alternativa.
- web: Corrigir os controles monocromáticos do modo escuro e alinhar o raio dos cantos do compositor de chat ao sistema de design.
- Corrigir a confirmação de `/login` para usuários que já estavam conectados, que era difícil de ler; agora ela usa a cor de sucesso.

## 0.31.1 (2026-07-31)

### Aprimoramentos

- Reduzir redesenhos frequentes de tela inteira na TUI.
- Preservar a saída parcial do assistente quando um turno é interrompido com Esc e lembrar o modelo de que o turno anterior foi interrompido deliberadamente.
- web: Ordenar os modos de permissão do mais seguro ao mais permissivo nas diferentes áreas de configurações e corrigir as cores de risco invertidas de yolo/auto no painel de status e nas configurações para dispositivos móveis.
- web: Habilitar o destaque baseado no Monaco para blocos de código e corrigir números de linha que se sobrepunham ou ficavam desalinhados em blocos de código renderizados pelo mecanismo alternativo.

### Correções de bugs

- Corrigir erros ocasionais de "modelo não configurado" ao iniciar o kimi web, causados pela atualização de provedores em segundo plano que limpava temporariamente o catálogo de modelos enquanto a primeira sessão estava sendo criada.
- web: Corrigir novas sessões que exibiam o nível de raciocínio (por exemplo, Max) enquanto a primeira mensagem era executada com o raciocínio desativado.
- web: Fazer a menção de arquivos com @ funcionar em um rascunho de uma nova sessão, antes que o primeiro prompt crie a sessão.
- web: Corrigir blocos de código do chat que eram renderizados com a fonte proporcional da interface em tamanho incorreto após a atualização do renderizador Markdown e alinhar o fallback de carregamento ao bloco com destaque.

## 0.31.0 (2026-07-30)

### Recursos

- Suportar agentes personalizados definidos em Markdown no agent-core.
- Adicionar o comando slash /secondary_model para configurar o modelo secundário usado pelos subagentes (experimental; habilite-o primeiro em /experiments).
- Plugins podem contribuir com agentes personalizados, que são descobertos automaticamente e ficam disponíveis para delegação aos subagentes.
- Plugins podem contribuir com instruções de prompt do sistema por meio de `systemPrompt` ou `systemPromptPath` em `kimi.plugin.json`.

### Correções de bugs

- Remover a espera bloqueante `block`/`timeout` da ferramenta TaskOutput para que verificar uma tarefa em segundo plano não possa mais travar a conversa; ela agora sempre retorna um snapshot imediato, e a conclusão continua sendo informada por meio de uma notificação automática.
- Corrigir sessões que não apareciam no seletor de sessões quando seus metadados em cache eram anteriores à flag de arquivamento.
- Corrigir cabeçalhos de solicitação que não eram enviados corretamente em algumas solicitações.

## 0.30.0 (2026-07-29)

### Recursos

- Adicionar uma linha de status personalizável no rodapé, configurada por meio de `[status_line]` em `tui.toml`.

### Aprimoramentos

- Exibir uma observação sobre a cota após instalar plugins oficiais que utilizam a cota do plano (como o Kimi Datasource).
- Exibir um aviso quando um plugin oficial usado na sessão tiver uma atualização disponível — execute /plugins para atualizá-lo.
- Remover o limite de tamanho de 50 MB para uploads de arquivos no servidor integrado.

### Correções de bugs

- Falhar imediatamente quando a cota ou o saldo da conta estiver esgotado, em vez de tentar novamente silenciosamente por ~3 minutos.
- Encerrar o turno após chamadas de ferramentas inválidas repetidas, em vez de tentar novamente indefinidamente.
- web: Corrigir números de linha corrompidos em blocos de código.

## 0.29.2 (2026-07-27)

### Correções de bugs

- Corrigir a pausa do cumprimento de objetivos quando um turno de objetivo atinge o limite de etapas por turno (`loop_control.max_steps_per_turn`).
- Corrigir mensagens enviadas durante o cumprimento de objetivos que eram rejeitadas.
- Corrigir o /undo para restaurar de forma consistente o histórico da conversa, as listas de tarefas, o modo de planejamento e as notificações de tarefas.
- web: Corrigir a cópia de texto selecionado do chat por HTTP simples que sobrescrevia a área de transferência com um marcador de evento.

## 0.29.1 (2026-07-24)

### Recursos

- Adicionar tempos limite globais padrão para servidores MCP no `config.toml` e nas variáveis de ambiente.
- Adicionar variáveis de ambiente para configurar os serviços de pesquisa e busca na web sem login OAuth.
- Adicionar associações experimentais de modelos secundários para subagentes recém-iniciados, incluindo preferências de modelo por agente e substituições de modelo exclusivas para subagentes.

### Correções de bugs

- Corrigir a perda do conteúdo de raciocínio em endpoints compatíveis com OpenAI que retornam o raciocínio usando um nome de campo diferente (por exemplo, versões mais recentes do vLLM).

## 0.29.0 (2026-07-22)

### Funcionalidades

- web: Suporte à definição de agentes em arquivos Markdown, declarando prompt do sistema, nome, descrição e permissões de ferramentas. [Detalhes](https://moonshotai.github.io/kimi-code/en/customization/agents.html#agent-file-format)
- web: Substituição permanente do prompt do sistema do agente principal usando SYSTEM.md. [Detalhes](https://moonshotai.github.io/kimi-code/en/customization/agents.html#overriding-the-main-agent-s-system-prompt-with-system-md)
- web: Ativação ou desativação global de ferramentas em todas as sessões por meio do config.toml. [Detalhes](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#tools)
- Vídeos anexados a um prompt agora chegam ao modelo junto com o prompt, sem uma rodada adicional de ferramentas.
- Suporte à seleção de um nível de thinking effort a partir de clientes ACP.
- Adição de substituições por variáveis de ambiente para os limites do agent loop e das background tasks.

### Melhorias

- Importação de muito mais provedores do catálogo models.dev.
- Melhoria do desempenho do TUI e da velocidade de retomada de sessões de longa duração.
- Reconexão automática de uma conexão perdida com um servidor MCP quando uma de suas ferramentas é chamada, com uma nova tentativa da chamada.
- Remoção da cor vermelha do syntax highlighting nas pré-visualizações de código e nos blocos de código Markdown.
- Adição de um lembrete para fontes de instalação de terceiros utilizarem o instalador oficial no prompt de atualização.

### Correções de bugs

- Correção de sessões que ficam travadas com o erro de provedor "message must not be empty" após uma resposta filtrada por conteúdo.
- Correção de solicitações de modelo canceladas que estavam sendo tratadas como erros de provedor que permitem novas tentativas.
- Correção da exibição de níveis de thinking para modelos que não oferecem suporte a eles.
- Correção de substituições de configuração por variáveis de ambiente que estavam sendo persistidas no config.toml enquanto a variável de ambiente estivesse definida.
- Envio da chave de cache do prompt da sessão para os provedores OpenAI e OpenAI Responses.
- Correção da falha do ReadMediaFile em vídeos quando o provedor não possui um canal de upload de arquivos.
- Correção de prompts de continuação do goal mode que vazavam para o transcript ao retomar uma sessão.
- web: Exibição de imagens transparentes sobre um canvas quadriculado.
- Remoção de referências ao comando inexistente `kimi resume` das descrições das ferramentas de tarefas agendadas.

## 0.28.1 (2026-07-20)

### Funcionalidades

- Permitir que sessões ACP sejam iniciadas com credenciais de modelo não-OAuth configuradas, em vez de exigir login pelo terminal.

### Melhorias

- Executar servidores web somente em primeiro plano de ponta a ponta: o comando /web agora sempre inicia um novo servidor, e os subcomandos `kimi web kill` / `kimi web ps` foram removidos — servidores em primeiro plano são encerrados com Ctrl+C. `kimi server kill` continua disponível como alternativa obsoleta que só encerra servidores iniciados por uma versão anterior à 0.28.0.

### Correções de bugs

- Corrigir subagentes em execução que não observavam alterações no modo de permissão feitas após seu início.

## 0.28.0 (2026-07-20)

### Funcionalidades

- **Breaking:**
  - A árvore de comandos `kimi server` está obsoleta; use `kimi web` em seu lugar.
  - `kimi web` agora é executado em primeiro plano no terminal atual e abre o navegador; encerre-o com Ctrl+C.

### Melhorias

- O thinking effort persiste apenas nos níveis abaixo do nível máximo do modelo (max).
- web: Adição de uma observação no seletor de modelos informando que a troca de modelo ou de thinking effort invalida o prompt cache existente.

### Correções de bugs

- Correção das descrições dos modos de permissão YOLO e Auto: YOLO aprova automaticamente as ações das ferramentas, mas o agente ainda pode fazer perguntas, enquanto Auto é totalmente autônomo e nunca faz perguntas.
- Correção do backend web que ignorava links simbólicos ao carregar arquivos AGENTS.md e ler arquivos.

## 0.27.0 (2026-07-17)

### Funcionalidades

- Adição do comando /copy para copiar a última mensagem do assistente para a área de transferência.
- O uso de uma chave de API para modelos de programação Kimi agora também busca automaticamente a lista de modelos mais recente.

### Melhorias

- Erros de conexão OAuth agora incluem a causa de rede subjacente (DNS, conexão recusada, TLS ou timeout), em vez de apenas "fetch failed".

### Correções de bugs

- Correção de rejeições repetidas de solicitações após uma resposta de modelo interrompida.
- Correção das proteções de rede da ferramenta integrada de busca de URLs: domínios manipulados e cadeias de redirecionamento não podem mais acessar serviços de loopback ou da rede interna.
- web: Correção de fórmulas LaTeX que eram renderizadas como texto sobreposto e ilegível quando a interface web era acessada pela rede.
- web: Correção de mensagens enfileiradas que reenviavam silenciosamente arquivos enviados anteriormente quando uma sessão era reaberta.
- web: Lembrança do nível de thinking por modelo, corrigindo um seletor de thinking vazio e sem resposta quando o modelo não oferece suporte ao nível armazenado.
- web: Correção de grupos de workspaces duplicados no Windows quando a mesma pasta é aberta com diferentes formas de escrever o caminho; agora suas sessões são listadas em um único grupo mesclado.
- Correção de arquivos AGENTS.md instalados como links simbólicos que eram ignorados pelo backend web.
- Correção de Esc e Ctrl+C que cancelavam a compactação em vez de fechar um painel /btw aberto.
- Correção do conteúdo de thinking composto apenas por espaços em branco, que era renderizado como uma linha vazia no transcript.
- Correção de `/export-debug-zip` e `kimi export`, que sobrescreviam o ZIP anterior em execuções repetidas para a mesma sessão; o nome de arquivo padrão agora inclui um timestamp.

## 0.26.0 (2026-07-16)

### Melhorias

- Expansão do conjunto de ferramentas do subagente coder para incluir tarefas em segundo plano, listas de tarefas, modo plan, invocação de skills e agentes aninhados, espelhando as capacidades do agente principal.
- Aviso nos seletores `/model` e `/effort` de que a troca invalida o prompt cache existente, com uma sugestão para usar `/new` e evitar custos adicionais de tokens.
- web: Atualização do catálogo de modelos de todos os provedores ao abrir o seletor de modelos, para que os modelos recém-disponibilizados sejam sempre exibidos.
- Otimização da formatação das unidades na exibição de uso do contexto.

### Correções de bugs

- Correção de uma sessão retomada que era marcada como recém-atualizada e movida para o topo da lista de sessões sem nenhuma nova atividade.
- Correção do indicador de tamanho do contexto que informava um uso de contexto inferior ao real do modelo.
- Correção de modelos do provedor Kimi encaminhados pelo protocolo Anthropic que exibiam incorretamente opções de esforço de raciocínio.
- Respeito à configuração explícita de thinking como "off" em provedores compatíveis com OpenAI (chat completions).
- Exibição de uma informação quando os usuários interrompem tarefas e preservação dos outros motivos de interrupção no contexto do modelo.
- Correção de uma condição de corrida em que retomar um subagente em segundo plano logo após ele ser interrompido manualmente poderia falhar com um erro de "already running".
- Reprodução do conteúdo vazio de thinking literalmente, em vez de substituí-lo por um espaço como placeholder em endpoints compatíveis com Anthropic e Kimi com thinking preservado.
- Manutenção das migrações legadas idempotentes em múltiplos diretórios Kimi e exibição de sessões danificadas ou não mapeadas em vez de ignorá-las silenciosamente.
- web: Correção da alça de redimensionamento da barra lateral que ficava coberta pelo fundo do compositor de chat.

## 0.25.0 (2026-07-16)

### Funcionalidades

- web: Anexar qualquer tipo de arquivo no chat — arquivos podem ser arrastados para qualquer lugar da janela, e arquivos, imagens e vídeos enviados são exibidos como chips no balão da mensagem.

### Melhorias

- web: Exibir diagnósticos completos para falhas nas solicitações ao modelo.
- Aplicar os perfis de esforço oficiais da Anthropic e um fallback de saída de 128k para modelos desconhecidos.

### Correções de bugs

- Corrigir a verificação do bearer token do servidor web que podia ser contornada por caminhos de API codificados em porcentagem, permitindo acesso não autenticado a todas as rotas da API.
- Corrigir a API do sistema de arquivos da sessão que seguia links simbólicos apontando para fora do workspace, permitindo acesso a arquivos do host além do diretório da sessão.
- web: Manter os indicadores de atividade da sessão sincronizados com o trabalho do agente e impedir conteúdo transmitido duplicado após condições de corrida na ativação da sessão ou novas tentativas do LLM.
- Corrigir modelos com nomes personalizados em provedores compatíveis com Anthropic que iniciavam novas sessões com o thinking desativado e não exibiam o controle de thinking em clientes ACP.
- Respeitar `adaptive_thinking = false` em modelos compatíveis com Anthropic, omitindo o parâmetro de esforço das solicitações.
- web: Corrigir a Content-Security-Policy em servidores vinculados a endereços que não são de loopback, que bloqueava o script de inicialização do tema da interface web e as fontes incluídas no pacote.
- Corrigir sessões que não conseguiam ser criadas quando o diretório do workspace era fornecido por meio de um link simbólico.
- Corrigir a CLI que era encerrada inesperadamente quando a leitura de uma imagem da área de transferência falhava; agora ela usa texto colado como alternativa.
- web: Corrigir subagentes em segundo plano concluídos que perdiam sua saída final após o recarregamento de uma sessão.
- web: Corrigir o Enter que não confirmava diálogos modais de confirmação em builds de desenvolvimento.
- web: Corrigir um subagente em segundo plano que aparecia como duas linhas idênticas no painel de agentes durante o streaming.
- Corrigir o log de diagnóstico que não registrava o erro real quando a CLI era encerrada inesperadamente.

## 0.24.2 (2026-07-15)

### Funcionalidades

- Adicionar a skill integrada `/check-kimi-code-docs`, que responde automaticamente a perguntas sobre o produto Kimi Code usando fontes da documentação oficial.

### Melhorias

- Alinhar o comportamento do `kimi -p` entre os diferentes engines: `print_background_mode` e `print_max_turns` agora são aplicados, e execuções de `/goal` permanecem ativas até que o objetivo seja concluído.
- O `kimi -p` agora permanece ativo por padrão enquanto houver tarefas em segundo plano pendentes, sem limite efetivo de espera ou de turnos, e envia cada conclusão de volta ao agente. Defina `print_background_mode = "exit"` ou `"drain"` para restaurar o comportamento antigo de sair após um único turno.
- As tarefas em segundo plano e os subagentes do `kimi -p` não atingem mais o tempo limite por padrão (o modo interativo permanece inalterado); restaure os limites com `[background] bash_task_timeout_s` ou `[subagent] timeout_ms`.
- O tempo limite de subagentes agora é de 2 horas por padrão em todos os modos; substitua esse valor com `[subagent] timeout_ms` ou `KIMI_SUBAGENT_TIMEOUT_MS`.
- O limite de novas tentativas do LLM por etapa foi aumentado de 3 para 10 tentativas, para que falhas temporárias do provedor (429 / sobrecarga) sejam novamente tentadas antes que um turno falhe; ajuste com `loop_control.max_retries_per_step`.
- Os workspaces agora permanecem sincronizados: novas sessões são registradas automaticamente, workspaces ausentes são restaurados na inicialização e os removidos permanecem removidos.
- O `kimi web` agora registra solicitações que falharam e operações importantes, facilitando o diagnóstico de problemas do daemon.
- web: Os cartões do AgentSwarm agora permanecem expandidos enquanto os subagentes ainda estão em execução.
- web: Os cartões minimizados de revisão do plano e de perguntas agora usam um chevron apontando para cima para expandir.

### Correções de bugs

- web: Corrigir o layout em dispositivos móveis no iOS, incluindo o compositor, as áreas seguras e as notificações.
- Corrigir novas sessões que não eram abertas em versões mais antigas da CLI.
- Corrigir notificações de conclusão que eram disparadas antecipadamente quando um subagente terminava enquanto o turno principal ainda estava em execução.
- Corrigir a interface web que exibia a versão incorreta da CLI.
- Corrigir IDs de chamadas de ferramentas do Gemini que colidiam entre turnos e faziam com que execuções do swarm fossem mescladas em um único cartão.
- web: Exibir detalhes do erro do servidor quando ações como interromper ou arquivar uma sessão falham.
- web: Corrigir respostas longas que ficavam travadas após a aba ser colocada em segundo plano.
- web: Corrigir os botões de cópia de blocos de código em conexões HTTP simples.
- web: Manter as sessões carregadas visíveis quando a lista de sessões falha ao ser recarregada.
- web: Restaurar a lista de membros do AgentSwarm após recarregar a página.
- web: Corrigir títulos de sessão que não eram gerados quando a primeira mensagem era um comando slash.
- web: Exibir o horário real de envio de cada mensagem após recarregar uma sessão.
- Corrigir vários problemas do modo de objetivos relacionados a orçamentos e limites de turnos, pausa e retomada, recuperação após falhas, mensagens de status finais e registros de objetivos persistidos inválidos.
- Corrigir objetivos substituídos que podiam afetar o orçamento do novo objetivo e rejeitar objetivos de subagentes de forma consistente.
- Corrigir as orientações exibidas quando um objetivo não pode ser pausado ou retomado.

### Refatorações

- Renomear o recurso de carregamento dinâmico de ferramentas de `select_tools` para `dynamically_loaded_tools`; o comportamento permanece inalterado.

## 0.24.1 (2026-07-14)

### Correções de bugs

- Corrigir sessões do Kimi que ficavam travadas quando o histórico com thinking preservado continha uma etapa de raciocínio vazia.
- Corrigir ferramentas integradas que ficavam indisponíveis quando o provedor do modelo ficava pronto após o início da sessão.
- Corrigir o roteamento do thinking effort: provedores que não são Kimi agora preservam os valores configurados, enquanto modelos Kimi validam as seleções em tempo de execução e usam um fallback seguro durante a resolução do modelo.
- web: Alinhar o tratamento dos níveis de thinking com a CLI: enviar o nível selecionado exatamente como definido, em vez de reduzi-lo silenciosamente; usar o padrão do próprio modelo quando nada for selecionado ou quando o modelo mudar; e persistir as escolhas explícitas como padrão para novas sessões.
- Preservar os resumos de conclusão de objetivos e exibir erros do LLM sem tipo, sem o prefixo de código de erro interno nos eventos de interrupção de etapas.

### Melhorias

- web: Exibir apenas o nome do nível (por exemplo, Max) no indicador do modelo, em vez de "thinking: max".

## 0.24.0 (2026-07-14)

### Funcionalidades

- web: Adicionar a exportação de sessões: execute `/export` ou selecione Export session no menu de opções de uma sessão para baixar a sessão e os logs de diagnóstico como um arquivo ZIP (limitado a 64 MiB).
- Mover comandos Bash executados em primeiro plano que atingirem o tempo limite para segundo plano, em vez de encerrá-los, para que comandos de longa duração continuem sendo executados e informem o resultado quando forem concluídos. Defina `bash_auto_background_on_timeout = false` em `[background]` no config.toml para restaurar o comportamento de encerrar o comando ao atingir o tempo limite.

### Melhorias

- web: Refinar os controles do modo de objetivos com interações animadas na faixa, progresso com base no orçamento e confirmação de cancelamento seguindo o sistema de design.
- Ao fechar uma sessão, as tarefas em segundo plano agora recebem uma solicitação para serem interrompidas e um período de tolerância antes de serem encerradas à força.
- Reescrever os lembretes de chamadas repetidas de ferramentas para direcionar o agente a uma ação diferente, em vez de proibir a chamada.
- Otimizar os prompts da ferramenta TaskOutput para desencorajar esperas bloqueantes por tarefas em segundo plano.
- Enviar o User-Agent `kimi-code-cli` nas solicitações ao registro de provedores (`api.json`) e ao catálogo de modelos, para que os registros possam identificar a versão do cliente.
- Registrar um aviso quando uma skill falhar ao ser analisada, em vez de descartá-la silenciosamente, e corrigir os resultados da verificação de skills que não eram reportados.

### Correções de bugs

- Impedir que leituras de imagens grandes demais prejudiquem as sessões; sessões que já falharam com erros de solicitação grande demais agora são recuperadas automaticamente.
- Corrigir o fork de sessões que perdia tudo, exceto o histórico da conversa: sessões derivadas agora carregam anexos de mídia, arquivos de plano, saída de tarefas em segundo plano e tarefas cron, e um fork com falha não deixa mais uma cópia corrompida para trás.
- web: Corrigir vários problemas de renderização de sessões ao reabri-las, reconectá-las ou ressincronizá-las, incluindo o indicador de uso do contexto que caía para 0, balões de mensagens do usuário duplicados e texto duplicado em turnos com várias etapas.
- web: Corrigir imagens enviadas que não eram exibidas ao conectar-se ao servidor por um endereço diferente de localhost.
- web: Continuar objetivos bloqueados depois que o usuário os retoma pelos controles de objetivos.
- web: Corrigir a lista de membros do AgentSwarm que desaparecia após atualizar a página enquanto os subagentes ainda estavam em execução.
- web: Corrigir o cartão de objetivo que desaparecia após atualizar a página enquanto um objetivo da sessão estava ativo.
- web: Corrigir o menu do seletor de workspace que ficava estreito demais para seu conteúdo.
- web: Recuperar limites de taxa temporários de subagentes sem exibi-los como erros da sessão.
- Corrigir a detecção automática do Bash no Windows que falhava quando o Git vinha de uma toolchain nativa do MSYS2 (ucrt64/clang64/clangarm64).
- Corrigir o login OAuth que ficava travado após a autorização no navegador quando a configuração do provedor mudava durante o login.
- Exibir a mensagem real de rejeição do provedor, em vez de um aviso enganoso para fazer login novamente, quando um modelo gerenciado por OAuth continua retornando 401 após uma atualização do token.
- Corrigir provedores sem `base_url` configurada que eram rejeitados: provedores dos protocolos anthropic/openai e outros agora voltam a usar seus endpoints oficiais padrão.
- Corrigir ferramentas MCP que ficavam indisponíveis no primeiro turno após a inicialização da sessão.
- Corrigir mídias e imagens coladas que eram descartadas dos argumentos de comandos de `/skill` e plugins, e ao enviar instruções com `Ctrl-S`.
- Corrigir blocos de raciocínio vazios que eram descartados entre provedores, o que quebrava chamadas de ferramentas em várias etapas.
- No modo de permissão automático, saídas do plano agora são marcadas como aprovadas automaticamente, em vez de revisadas pelo usuário, para que o agente não confunda a aprovação com um sinal do usuário para começar a executar.
- Corrigir tarefas em segundo plano que eram perdidas ou marcadas incorretamente como perdidas ao retomar sessões.
- Corrigir o encerramento do servidor que, em alguns casos, deixava para trás um arquivo de instância obsoleto.

### Refatorações

- O `kimi web` agora é executado por padrão no mecanismo de agente reformulado.

## 0.23.6 (2026-07-12)

### Melhorias

- web: Permitir que tabelas Markdown largas ultrapassem a coluna de leitura, até o limite de 1040 px, com rolagem horizontal dentro da própria tabela quando necessário.
- web: Manter o token de acesso ao servidor por até 7 dias, mesmo após fechar a aba ou reiniciar o navegador, em vez de solicitá-lo novamente a cada nova aba.
- web: Adicionar workspaces digitando diretamente um caminho absoluto na caixa de pesquisa do seletor de workspaces, com validação em tempo real e sugestões de conclusão.
- web: Ativar automaticamente o nível padrão de thinking effort ao trocar para um modelo que oferece suporte a níveis de esforço na interface web.
- Reconhecer os campos `support_efforts` e `default_effort` ao importar um registro personalizado, disponibilizando níveis de thinking effort para esses modelos.
- Atualizar o link da página de instalação do WebBridge aberto pelo painel `/plugins`.
- Adicionar a opção de configuração `subagent.timeout_ms` (ou a variável de ambiente `KIMI_SUBAGENT_TIMEOUT_MS`) para controlar por quanto tempo um único subagente pode ser executado antes de atingir o tempo limite; o padrão aumenta de 30 minutos para 2 horas.
- Adicionar uma política para tarefas em segundo plano no modo de impressão: defina `[background].print_background_mode = "steer"` para manter o `kimi -p` ativo após a conclusão de tarefas em segundo plano, permitindo que o agente principal receba instruções para executar turnos adicionais.

### Correções de bugs

- web: Corrigir sessões que ficavam presas no estado de envio após uma reconexão; turnos concluídos enquanto a conexão estava indisponível agora interrompem o indicador de carregamento e permitem enviar a próxima mensagem normalmente.
- web: Corrigir a primeira visita após iniciar ou atualizar a interface web, que redirecionava para a página de login quando a verificação inicial de autenticação falhava; a tela de conexão agora permanece visível, exibe o erro de conexão e tenta novamente.
- Manter execuções do `kimi -p` ativas após o término de um turno enquanto um objetivo ainda estiver ativo ou uma tarefa cron estiver pendente, permitindo que continuações de objetivos e execuções cron realizem seus turnos em vez de serem interrompidas quando o turno principal termina.
- Tratar uma pergunta descartada como uma escolha do usuário de não responder, em vez de selecionar implicitamente a opção recomendada.
- web: Corrigir resultados de `ReadMediaFile` que eram renderizados como cartões de ferramentas comuns, em vez de imagens, após retomar ou recarregar uma sessão.
- web: Corrigir a visualização do chat que se deslocava para baixo durante a rolagem pelo histórico da conversa.
- web: Corrigir o menu suspenso de modelos que exibia marcas de seleção em modelos de outros provedores com o mesmo nome; agora, o modelo atual é identificado pelo seu ID exclusivo.
- web: Corrigir a lentidão da barra lateral com muitas sessões, removendo verificações repetidas da lista de sessões durante a renderização.

### Refatorações

- Renomear a capacidade de carregamento dinâmico de ferramentas do modelo de `select_tools` para `dynamically_loaded_tools`.

## 0.23.5 (2026-07-10)

### Melhorias

- Tentar novamente solicitações com erros 429, sobrecarga e outros erros temporários do provedor de forma mais confiável, respeitando o intervalo `Retry-After` informado pelo servidor e exibindo as novas tentativas em `-p --output-format stream-json`.

### Correções de bugs

- Impedir que formatos de imagem não suportados (AVIF, BMP, TIFF, ICO, …) interrompam sessões em qualquer ponto de entrada — incluindo URLs de imagens remotas e imagens identificadas incorretamente por uma ferramenta — e recuperar sessões que já estejam travadas removendo a imagem problemática e tentando novamente, para que uma única imagem desse tipo não faça todas as solicitações seguintes falharem.
- web: Corrigir a notificação de desktop "Turn finished" e o som de conclusão, que eram acionados duas vezes por turno.
- web: Ocultar a mensagem interna sobre compressão de imagens para que ela não seja mais exibida como texto de mensagem do usuário.

## 0.23.4 (2026-07-10)

### Funcionalidades

- web: Adicionar notificações quando uma ferramenta precisar de aprovação e melhorar a confiabilidade das notificações.

### Melhorias

- web: Aprimorar a interface do chat com a tipografia Inter, rótulos localizados e estilos mais refinados para o compositor e os menus.
- web: Aprimorar o layout, as cores, os ícones e a tipografia da barra lateral de sessões.
- Exibir o saldo de Extra Usage (pacote de créditos) nos comandos `/usage` e `/status`.
- Adicionar uma entrada do Kimi WebBridge à aba Official do painel `/plugins`, que abre a página de instalação do WebBridge no navegador.

### Correções de bugs

- Manter sessões com muitas imagens dentro dos limites de tamanho das solicitações dos provedores: imagens grandes demais (lidas pelo modelo ou coladas, incluindo WebP) são redimensionadas e comprimidas; leituras de HEIC/HEIF são recusadas com um comando de conversão compatível com a plataforma, em vez de comprometer a sessão; e erros HTTP 413 por solicitação grande demais agora são recuperados automaticamente — a solicitação e a nova tentativa de `/compact` substituem mídias antigas por marcadores de texto. Os limites podem ser configurados em `[image]` no `config.toml` (ou pelas variáveis de ambiente `KIMI_IMAGE_*`), e cada core mantém suas próprias configurações, evitando que recarregar a configuração de um cliente altere a compressão de outro.
- Corrigir a retomada de sessões cujo diretório de trabalho original não existe mais.
- Corrigir objetivos no modo de prompt para que sejam executados até a conclusão e para que comandos de objetivo inválidos sejam informados antes do envio dos prompts.
- web: Corrigir o erro ocasional "another turn is active" ao enviar a primeira mensagem de uma nova conversa e exibir um estado de inicialização enquanto ela está sendo enviada.

## 0.23.3 (2026-07-08)

### Correções de bugs

- Corrigir a mensagem enganosa "OAuth login expired", exibida quando um modelo não está disponível para a conta atual.

## 0.23.2 (2026-07-08)

### Funcionalidades

- Adicionar o plugin Vercel ao marketplace de plugins integrado. Execute `/plugins` e selecione Vercel Plugin para instalá-lo.

### Correções de bugs

- Corrigir execuções do `kimi -p` que terminavam com código 0 quando um turno falhava.
- Impedir que atualizações de status informadas pelo modelo pausem objetivos autônomos.
- Contabilizar o turno que inicia um objetivo autônomo no limite de turnos desse objetivo.
- Aumentar o limite de redução de imagens de 2000 px para 3000 px e corrigir a inversão de largura e altura em fotos com rotação EXIF (retrato), tanto nas legendas de compressão quanto nas notas de leitura de mídia, para que as coordenadas de leitura de regiões correspondam corretamente.
- web: Corrigir a notificação de erro de conexão que permanecia visível após a reconexão do WebSocket ao retornar da execução em segundo plano.
- Corrigir as janelas do console que piscavam no Windows sempre que um hook era executado.

### Melhorias

- web: Reformular a interface de lembretes agendados.
- web: Exibir as skills da sessão no menu slash no formato `/skill:<name>`, para diferenciá-las dos comandos integrados; digitar apenas o nome da skill continua funcionando.
- web: O seletor de modelos do compositor continua alterando o modelo da sessão ativa, como antes, e agora também atualiza o modelo padrão global, para que novas sessões herdem essa escolha.
- web: Pressionar Enter para confirmar em diálogos de arquivamento e outras caixas de confirmação.
- Refinar as orientações do modo de objetivos para atualizações de status bloqueado e concluído.
- Divulgação progressiva de ferramentas (`select_tools`, experimental): a compactação agora descarta os esquemas das ferramentas carregadas em vez de reinseri-los, e o modelo seleciona novamente as ferramentas de que ainda precisa. Uma chamada feita com informações da memória para uma ferramenta que não está mais carregada é rejeitada, com orientações para selecioná-la primeiro. Não há efeito a menos que a flag experimental `tool-select` e um modelo compatível com `select_tools` estejam ativos.

### Refatorações

- web: Compilar os ícones durante o build para que a interface web incluída no pacote contenha apenas os ícones que utiliza.

## 0.23.1 (2026-07-07)

### Correções de bugs

- Corrigir o `kimi -p` que abandonava subagentes em segundo plano que começavam a executar tarde ou demoravam muito, garantindo que seus resultados chegassem ao agente principal.
- web: Recuperar o streaming do chat após uma conexão WebSocket obsoleta em uma aba em segundo plano, sem exigir que a página seja recarregada.
- Corrigir alguns modelos de terceiros (por exemplo, Opus 4.8) que usavam como fallback o limite máximo de tokens de saída padrão da família; versões secundárias não reconhecidas agora reutilizam o limite da versão conhecida anterior mais próxima.
- Respeitar as configurações explícitas de `max_output_size` da Anthropic, em vez de limitá-las aos tetos definidos internamente.
- Parar de exibir metadados `<system>` produzidos por ferramentas nas saídas dessas ferramentas; ferramentas com falha agora exibem suas próprias mensagens de erro.
- Corrigir a conclusão de objetivos e as atualizações de status bloqueado para que produzam um único resumo final do resultado, voltado ao usuário, com base no resultado da ferramenta.
- Corrigir a inicialização de objetivos e o gerenciamento da fila para que inicializações com falha restaurem o modo de permissão e objetivos enfileirados aguardem atrás de novas mensagens do usuário.
- Corrigir os orçamentos de tokens dos objetivos para contabilizar os tokens de conclusão do modelo e interromper a execução sem etapas adicionais de continuação quando o orçamento se esgotar.
- Corrigir ferramentas de objetivos que estavam indisponíveis para o agente principal e retornar mensagens claras para chamadas inválidas de controle de objetivos.
- Respeitar a flag `--skills-dir` no modo interativo.
- web: Corrigir vários comandos slash e skills que não funcionavam na tela de nova sessão: `/goal <objective>` e ativações de skills por comandos slash (por exemplo, `/pre-changelog`) não faziam nada silenciosamente, e `/btw [<question>]` abria um chat lateral vazio.

### Melhorias

- Preservar por padrão o thinking dos turnos anteriores no provedor Anthropic (Claude e o modo compatível com Anthropic do Kimi), seguindo o padrão do Kimi. Desative com `[thinking] keep = "off"` ou `KIMI_MODEL_THINKING_KEEP=off`.
- Esclarecer as descrições dos modos de permissão exibidas por `/permission`, `/auto` e `/yolo`, além de reordenar `/auto` e `/yolo` na lista de comandos.
- Exibir em horas os lembretes sobre o orçamento de tempo total dos objetivos de longa duração.
- Refinar as orientações do modo de objetivos para que os agentes continuem trabalhos razoáveis ao longo de vários turnos, em vez de encerrar os objetivos prematuramente.

### Refatorações

- Registrar um rastreamento por solicitação no log de comunicação da sessão, permitindo reconstruir as solicitações ao modelo para fins de depuração.

## 0.23.0 (2026-07-06)

### Funcionalidades

- web: Adicionar uma página de sessões arquivadas nas configurações para consultar e restaurar sessões arquivadas. Acesse Configurações → Archived para encontrá-la.
- Adicionar o carregamento experimental de ferramentas sob demanda (`select_tools`), controlado pela flag `tool-select`: um modelo compatível carrega ferramentas MCP somente quando necessário, em vez de enviar todas elas em cada solicitação, preservando o prompt cache do provedor. Desativado por padrão e ativo apenas em modelos que declaram o recurso `select_tools`.

### Correções de bugs

- Corrigir sessões que existem no disco, mas estavam ausentes da lista de sessões ou retornavam erro 404 ao serem acessadas diretamente, reconstruindo o índice de sessões na inicialização do servidor.
- Corrigir os cartões das ferramentas Bash e Edit, que encolhiam, saltavam ou piscavam em altura enquanto os resultados eram transmitidos ou terminavam com uma saída curta, e separar visualmente o comando Bash de sua saída.
- Corrigir o campo de entrada que se deslocava para cima após o fechamento do menu de comandos slash.
- Corrigir a prévia de aprovação de edições exibida por Ctrl+E para incluir linhas de contexto ao redor, seguindo o painel de resumo.
- Corrigir a conclusão de arquivos com `@`, que não encontrava arquivos profundamente aninhados em projetos grandes após a adição de diretórios extras ao workspace.
- web: Corrigir vários problemas de layout e animação: a barra lateral recolhida agora é ocultada corretamente, o histórico do chat não reproduz mais a animação de entrada ao abrir uma sessão e os componentes das ferramentas não deslocam mais a conversa ao serem expandidos ou recolhidos.
- web: Corrigir os disparos de lembretes agendados (cron) que ficavam ocultos; agora eles aparecem no chat como cartões de aviso.
- web: Corrigir o final de uma resposta que desaparecia após reabrir uma sessão.
- web: Corrigir mensagens de mídia enfileiradas que não eram carregadas de volta no compositor e preservar os anexos ao desfazer uma mensagem.
- web: Impedir que a barra de ferramentas do compositor corte seus controles em janelas estreitas e celulares, mantendo o indicador circular de contexto visível em qualquer largura.
- web: Corrigir a configuração de tamanho da fonte para que o texto do chat, do compositor e da barra lateral siga o tamanho selecionado.
- web: Corrigir o cursor de entrada quase invisível do compositor e o tachado pouco visível nos itens de tarefas concluídos.
- web: Exibir o atalho correto para pesquisar sessões no Windows.
- Corrigir chamadas de ferramentas com modelos Google Gemini, incluindo a preservação e o envio de assinaturas de thinking do Gemini 3 entre turnos.

### Melhorias

- web: Substituir o rodapé do swarm por um único cartão de ferramenta integrado ao chat, que exibe o progresso dos subagentes em tempo real e o resultado agregado, mantendo estável a barra de progresso do swarm após atualizar a página.
- Exibir resumos da compactação na TUI após a compactação. Pressione Ctrl+O para mostrar ou ocultar o resumo.
- web: Renderizar respostas de AskUserQuestion como uma lista de opções legível, destacando as opções escolhidas, em vez de exibir JSON bruto.
- web: Exibir as skills disponíveis no compositor antes da criação de uma sessão.
- web: Adicionar uma entrada de sessões arquivadas ao painel de configurações para dispositivos móveis e esclarecer a confirmação de arquivamento, mencionando que a restauração pode ser feita nas configurações.
- web: Exibir o ícone do Kimi e títulos mais claros nas notificações da área de trabalho.
- web: Alinhar o bloco de código de diferenças Markdown ao sistema de design: o texto do código mantém a cor normal, enquanto o sinal e um fundo suave na linha indicam a alteração, seguindo o painel `~/diff`.
- web: Impedir a hifenização do texto do chat nas quebras de linha e renderizar código sem ligaduras tipográficas.
- web: Remover a indentação extra à esquerda do corpo dos cartões de chamadas de ferramentas, para que o conteúdo expandido fique alinhado ao cabeçalho.
- Enviar as respostas de AskUserQuestion de volta ao modelo como texto das perguntas e rótulos das opções, em vez de IDs posicionais, eliminando a necessidade de o modelo associá-los novamente. Os textos das perguntas agora devem ser únicos em cada chamada, e os rótulos das opções devem ser únicos dentro de cada pergunta; clientes existentes continuam respondendo com IDs de opções, portanto não é necessária nenhuma alteração no cliente.
- Preservar por padrão o raciocínio de turnos anteriores nos modelos Kimi quando o thinking estiver ativado. Defina `[thinking] keep = "off"` para desativar.

## 0.22.3 (2026-07-04)

### Correções de bugs

- Aguardar que os subagentes em segundo plano terminem e responder aos resultados deles antes de sair no `kimi -p`, em vez de encerrar o turno antecipadamente.
- web: Corrigir vídeos enviados que não eram reproduzidos no chat da interface web.
- Reverter as alterações recentes na renderização do histórico da TUI para o comportamento original do projeto upstream e corrigir problemas de renderização relacionados.

### Melhorias

- Adicionar as flags `--dangerous-bypass-auth` e `--keep-alive` ao comando `kimi server run`, permitindo que o servidor seja executado sem um token em redes confiáveis e permaneça ativo além do tempo limite de inatividade.
- web: Adicionar a opção de ampliar imagens enviadas no chat da interface web ao clicar nelas. Clique em uma imagem de uma mensagem para abri-la.

## 0.22.2 (2026-07-03)

### Correções de bugs

- Corrigir sessões que descartavam silenciosamente mensagens posteriores do usuário após um turno ser interrompido entre uma chamada de ferramenta e seu resultado.
- Corrigir solicitações rejeitadas por provedores rigorosos quando o modelo emite IDs duplicados para chamadas de ferramentas.
- Corrigir falhas do `kimi upgrade` no Windows, que apresentava um erro de spawn ao instalar a nova versão.
- Corrigir conteúdo duplicado do histórico da conversa que aparecia na área de rolagem durante o streaming.
- Corrigir prompts com imagens comprimidas que expunham uma nota interna de compressão `<system>` na mensagem visível e no título da sessão.
- Impedir que atualizações automáticas em segundo plano façam uma janela do console piscar no Windows.

### Melhorias

- Fazer com que as notas de compactação do contexto registrem um plano para o trabalho restante — próximas etapas, decisões já definidas e obstáculos previsíveis — em vez de apenas a próxima etapa imediata, permitindo que o agente continue de forma mais coerente após a compactação automática.
- Complementar o PATH com os caminhos do shell de login do usuário durante a inicialização, para que os comandos do shell encontrem ferramentas instaladas pelo usuário (por exemplo, o `gh` do Homebrew), mesmo quando o kimi-code for iniciado sem o PATH completo do perfil.
- Promover a regra de correspondência de idioma para uma seção específica no prompt do sistema, garantindo que as respostas e o raciocínio sigam consistentemente o idioma do usuário mesmo após longas saídas de ferramentas em inglês, enquanto os artefatos do repositório mantêm as convenções do projeto.
- Adicionar uma preferência da TUI para impedir que colagens rápidas com várias linhas sejam enviadas linha por linha quando o recurso de colagem delimitada não estiver disponível. Defina `disable_paste_burst = true` no `tui.toml` para desativar esse comportamento.
- Manter os cartões dos subagentes com altura estável e exibir um indicador de atividade animado em tempo real, com uma janela compacta de atividade de duas linhas.
- Nas execuções do `kimi -p`, aguardar a conclusão dos subagentes em segundo plano antes de sair quando `background.keep_alive_on_exit` estiver ativado. Defina `keep_alive_on_exit = true` para permitir que subagentes simultâneos em segundo plano concluam suas tarefas.

### Refatorações

- Registrar os IDs das respostas do modelo nos logs de comunicação da sessão para facilitar o rastreamento de solicitações individuais ao modelo.

## 0.22.1 (2026-07-02)

### Correções de bugs

- Corrigir erros de renderização da TUI que faziam a tela ficar em branco e a caixa de entrada desaparecer.
- Corrigir falhas da TUI quando o terminal era redimensionado para uma largura muito estreita enquanto o campo de entrada continha texto em CJK ou emojis.
- Corrigir a lentidão da interface web após a abertura de muitas sessões.
- Limpar completamente a tela ao iniciar uma nova sessão por meio de `/new`, `/clear` ou da troca de sessão.
- Corrigir tooltips da interface web que permaneciam presos na tela quando o elemento que os acionava era removido enquanto estavam abertos.
- Corrigir a linha de sessão da barra lateral, que deslocava o título e os indicadores de status ao passar o cursor sobre ela.
- Corrigir a caixa de diálogo de pesquisa de sessões, que exibia uma barra de rolagem horizontal para títulos ou trechos longos.

### Melhorias

- Aprimorar os resumos de transferência de contexto durante a compactação para tornar a retomada de sessões mais confiável. Agora, eles preservam a intenção mais recente, os principais resultados das ferramentas, as decisões, as questões em aberto e o contexto que precisa ser verificado novamente.
- Salvar comandos do shell no histórico de entrada e recuperá-los no modo Bash. Pressione a seta para cima em um prompt `!` vazio para navegar pelos comandos anteriores do shell.
- Quando imagens grandes forem comprimidas, informar ao modelo os detalhes da imagem original e da imagem enviada. Manter a imagem original disponível e oferecer suporte à leitura de recortes ou da resolução completa para examinar detalhes minuciosos.
- Atualizar o conjunto de ícones da interface web e unificar os estados de destaque ao passar o cursor e as dicas de ferramentas dos botões de copiar mensagem e desfazer.
- Permitir que a barra lateral da interface web recolha uma lista expandida de sessões de um workspace de volta à primeira página.
- Remover tooltips redundantes e incorretos da interface web.
- Exibir uma seta para cima no botão de envio do compositor da interface web.

### Refatorações

- Remover o recurso experimental de microcompactação e sua opção de alternância no painel de experimentos.
- Remover o tratamento duplicado de atalhos de nova linha do editor de prompts.

## 0.22.0 (2026-07-02)

### Funcionalidades

- Comprimir automaticamente imagens grandes demais antes de enviá-las ao modelo, reduzindo a resolução e recodificando-as para diminuir o custo de tokens de visão e evitar erros de tamanho de imagem dos provedores.
- Adicionar substituições de aliases de modelos, permitindo definir metadados de modelos em `[models."<alias>".overrides]` para substituir os resultados das atualizações do catálogo do provedor.

### Correções de bugs

- Corrigir os modos de plano, swarm e objetivo que eram compartilhados entre sessões na interface web; agora, cada sessão mantém suas próprias opções de ativação.
- Corrigir o histórico da conversa que saltava para o topo ao rolar para cima durante a transmissão de respostas.
- Liberar imagens coladas e temporizadores de streaming quando não estiverem mais sendo exibidos, impedindo que o uso de memória continue aumentando em sessões longas.
- Corrigir o terminal que permanecia no modo raw, com o cursor oculto e o controle de fluxo desativado, após uma falha ou encerramento abrupto.
- Corrigir workspaces ativos que exibiam apenas suas cinco sessões mais recentes ao carregar; agora, o sistema continua carregando sessões mais antigas das últimas 12 horas.
- Corrigir a configuração que ativa o Thinking por padrão e não estava surtindo efeito; agora, novas sessões começam corretamente com o thinking ativado.
- Corrigir erros indevidos nas ações de perguntas, aprovações e tarefas da interface web quando a ação já havia sido concluída, além de adicionar indicadores de carregamento para confirmar imediatamente cada clique.
- Exibir solicitações de pull request em rascunho com um status específico, em vez de mostrá-las como abertas.
- Ocultar o contorno da conversa quando não houver espaço suficiente para expandir seus rótulos, evitando que sejam cortados na borda da janela.
- Ocultar a opção Off, que não é compatível, no seletor de thinking de `/model` para modelos com thinking sempre ativado que já oferecem vários níveis de esforço.

### Melhorias

- Atualizar a interface web com um novo sistema de design, incluindo cores, tipografia e espaçamento renovados, paletas para temas claro e escuro, tooltips reformulados e animações sutis de entrada, saída, expansão e recolhimento.
- Agrupar chamadas consecutivas de ferramentas em um bloco recolhível com renderizadores específicos para cada ferramenta, incluindo indicadores da quantidade de linhas alteradas em diffs e prévias integradas para resultados de imagens, vídeos e áudio.
- Aprimorar a pesquisa de sessões com uma janela de busca Cmd/Ctrl+K que filtra por título, workspace e último prompt, destacando as correspondências. Pressione Cmd+K ou Ctrl+K para abri-la.
- Exibir prompts enfileirados diretamente abaixo do turno em execução no chat web e separar o botão Stop em um controle próprio, para que Send não interrompa mais a execução.
- Exibir o contorno da conversa com uma entrada por consulta do usuário, que se expande ao passar o cursor para mostrar uma lista identificada por rótulos.
- Substituir as opções de tema Explore e Native por um único layout de chat e uma configuração de cor de destaque Blue ou Black.
- Adicionar à barra lateral opções para ordenar workspaces manualmente ou pelo horário da última edição, além de controles para recolher ou expandir todos.
- Exibir informações de horário, duração, conexão e pilha nos avisos de erro e alerta da interface web.
- Usar uma única caixa de diálogo modal para confirmações na interface web, incluindo arquivamento de sessões, exclusão de workspaces e provedores, desfazer mensagens e alternância de modos.
- Reduzir o tamanho padrão da janela do histórico da TUI para manter a responsividade em sessões longas.
- Reduzir a altura padrão do compositor web para deixar o estado vazio mais compacto e corrigir a seta para cima que recuperava a mensagem anterior durante a edição de um rascunho com várias linhas; agora, ela só recupera a mensagem quando o cursor está no início absoluto do texto e fica desativada no editor expandido.
- Remover a animação de desaparecimento ao desfazer uma mensagem no chat web.

## 0.21.1 (2026-07-01)

### Correções de bugs

- Manter o indicador de carregamento visível enquanto o raciocínio criptografado é transmitido, corrigindo o intervalo em branco, sem indicador, que ocorria antes da exibição do primeiro texto da resposta.

## 0.21.0 (2026-07-01)

### Funcionalidades

- Plugins agora podem fornecer comandos slash por meio de um campo `commands` em seu manifesto, registrados no formato `\<plugin>:\<command>` e executados com a expansão de `$ARGUMENTS`.
- Adicionar renderização de diagramas Mermaid ao chat web. Blocos de código delimitados com `mermaid` nas respostas do assistente agora são renderizados como diagramas. O processamento de fórmulas matemáticas com KaTeX e a interpretação de diagramas Mermaid também são executados em Web Workers para manter a interface responsiva durante o streaming em tempo real.

### Correções de bugs

- Impedir que um histórico de mensagens malformado inutilize permanentemente uma sessão em provedores rigorosos (Anthropic). A solicitação é corrigida antes do envio — chamadas de ferramentas sem resultado são encerradas e blocos de texto vazios ou contendo apenas espaços em branco são descartados. Se o provedor ainda rejeitar a estrutura, a solicitação será reenviada uma vez com uma reconstrução compatível com o protocolo.
- Forçar o encerramento de execuções headless (`kimi -p`) para impedir que um handle com referência pendente, deixado pela execução, mantenha um processo concluído ativo até atingir um timeout externo. Também limitar a limpeza de prompts para impedir que uma etapa de encerramento travada bloqueie o desligamento.
- Corrigir menções de arquivos com `@` que não abriam quando digitadas dentro de argumentos de comandos slash.
- Corrigir a adição de um workspace por caminho na interface web, que falhava silenciosamente quando o daemon rejeitava o caminho; agora, um erro é exibido em vez de criar um workspace inválido.
- Corrigir workspaces duplicados exibidos na barra lateral da interface web quando a mesma pasta era registrada mais de uma vez.
- Corrigir a renomeação de workspaces na interface web, que não era persistida após atualizar a página.

### Melhorias

- Adicionar um atalho de dois pressionamentos de Esc para abrir o seletor de desfazer. Pressione Esc duas vezes enquanto estiver ocioso para desfazer uma ação.
- Exibir sugestões de caminhos de arquivos ao digitar `/` no modo shell (`!`).
- Sempre exibir a opção para desativar a coleta de dados de uso nas configurações da interface web, com um rótulo e uma descrição mais claros.

### Refatorações

- Reformular a compactação do histórico da conversa:
  - Manter apenas os prompts recentes do usuário e um único resumo com papel de usuário; descartar mensagens do assistente e das ferramentas.
  - Corrigir a adjacência entre `tool_use` e `tool_result` antes do envio, resolvendo um erro HTTP 400 em provedores rigorosos quando uma chamada de ferramenta e seu resultado deixavam de ser consecutivos.
  - Mesclar turnos consecutivos do usuário para provedores rigorosos (Gemini/Vertex), corrigindo um erro HTTP 400 ("roles must alternate") após a compactação ou quando um turno era direcionado ao agente logo após o resultado de uma ferramenta.
  - A microcompactação agora fica desativada por padrão.
- Refatorar o sistema de níveis de esforço de thinking.
- Adicionar uma API de armazenamento de chave-valor no servidor para persistir as preferências da interface web no diretório de dados do usuário.

## 0.20.3 (2026-06-30)

### Correções de bugs

- Corrigir mensagens de erro dos provedores que eram exibidas como linhas em branco na TUI quando o servidor retornava uma página de erro HTML.
- Corrigir o compositor da interface web que ficava oculto atrás da barra de ferramentas do Safari para dispositivos móveis e o zoom automático da página ao focar no compositor.

### Melhorias

- Atualizar automaticamente as listas de modelos dos provedores em segundo plano, em vez de apenas na inicialização, para que novos modelos disponíveis apareçam sem precisar reiniciar o aplicativo.
- Glob agora utiliza ripgrep, respeitando `.gitignore` por padrão, oferecendo suporte a padrões com chaves, retornando apenas arquivos e preservando resultados parciais com um aviso quando alguns diretórios não podem ser lidos.

### Refatorações

- Alinhar o tratamento de argumentos malformados em chamadas de ferramentas ao mecanismo alternativo de validação de esquemas.

## 0.20.2 (2026-06-29)

### Funcionalidades

- Adicionar suporte ao protocolo compatível com Anthropic para o Kimi Code, incluindo entrada de vídeo.
- Adicionar um som de conclusão e notificações de perguntas à interface web, com opções separadas nas configurações para notificações de conclusão, notificações de perguntas e som. As notificações de perguntas ficam desativadas por padrão, para que o texto das perguntas só seja enviado à área de trabalho após você ativá-las.
- Adicionar `KIMI_CODE_CUSTOM_HEADERS` para permitir cabeçalhos personalizados nas solicitações LLM de saída e enviar o cabeçalho `User-Agent` para provedores que não sejam Kimi. Defina `KIMI_CODE_CUSTOM_HEADERS` usando linhas no formato `Name: Value`, separadas por quebras de linha.
- Adicionar o parâmetro opcional `exclude_empty` à API de listagem de sessões, permitindo omitir sessões que não possuem mensagens.

### Correções de bugs

- Recuperar-se de estouros de contexto HTTP 413 dos provedores realizando a compactação antes de tentar novamente.
- Limitar a saída da compactação a 128k tokens por padrão para evitar erros de `max_tokens` dos provedores.
- Corrigir a compactação que ignorava o tamanho máximo de saída configurado.
- Corrigir redesenhos desnecessários da tela inteira ao digitar na caixa de entrada ou alternar o painel de comandos slash.
- Manter os anexos ainda não enviados do compositor vinculados à própria sessão na interface web, impedindo que a troca de sessões os transfira para a próxima mensagem de outra sessão.
- Corrigir o compositor web que, ocasionalmente, mantinha o texto digitado após o envio da primeira mensagem de uma nova sessão.
- Corrigir informações de tempo de depuração que permaneciam visíveis após desfazer um turno.
- Corrigir dicas de trabalho que ficavam comprimidas contra a barra de progresso do AgentSwarm.

### Melhorias

- Reformular o cartão de perguntas ao usuário da interface web como um assistente passo a passo, facilitando a navegação entre várias perguntas e a visualização da ação final de envio (Submit).
- Na interface web integrada, uma nova sessão agora só é criada quando a primeira mensagem é enviada. Assim, selecionar `+ New` sem um workspace abre o compositor em vez de criar uma sessão vazia.
- Restaurar a posição de rolagem de cada sessão ao voltar para ela na interface web.
- Manter aberto o painel lateral ao alternar entre sessões na interface web.
- Vincular o histórico de navegação de entrada pelas setas para cima e para baixo do compositor web à sessão atual, em vez de compartilhá-lo entre todas as sessões.
- Na interface web integrada, `/new` e `/clear` agora são aliases que abrem o compositor de início de sessão e posicionam o foco no campo de entrada. O zoom automático do iOS é evitado mantendo os campos de texto com tamanho de 16 px, em vez de desativar o dimensionamento da viewport.
- Ocultar por padrão da lista de sessões da interface web as entradas "New Session" não utilizadas.
- Remover o comando slash `/sessions` da interface web; a barra lateral já permite navegar pelas sessões.
- Exibir as cinco primeiras sessões de cada workspace na barra lateral da interface web, em vez de dez.
- Substituir o ícone de mais (+) do botão de anexos do compositor web por um ícone de imagem.

### Refatorações

- Direcionar os modelos Kimi Code que utilizam o protocolo compatível com Anthropic para a API Messages beta.
- Atualizar as dependências do renderizador Markdown da interface web (katex, markstream-vue, shiki) para obter correções de bugs e melhorias de desempenho.
- Adicionar atributos de tipo e protocolo do provedor à telemetria de erros de turnos e de API.

## 0.20.1 (2026-06-26)

### Funcionalidades

- Plugins agora oferecem suporte à declaração de hooks de ciclo de vida em `kimi.plugin.json` para executar scripts em etapas específicas. Consulte [Hooks em Plugins](../customization/plugins.md#hooks-in-plugins).
- `/feedback` agora permite anexar logs de diagnóstico e contexto da base de código.
- Adicionar o comando `kimi update`, equivalente a `kimi upgrade`, para atualizar para a versão mais recente.
- `kimi web` adiciona a opção `--allowed-host <host>` para incluir um Host específico na lista de permissões de DNS rebinding. Os erros 403 agora explicam como permiti-lo por meio de `--allowed-host` ou `KIMI_CODE_ALLOWED_HOSTS`. Exemplo: `kimi web --allowed-host example.com`.

### Correções de bugs

- Corrigir a falha na inicialização do servidor Kimi no Windows após a primeira execução.
- Corrigir o problema em que a interface web aberta pelo comando `/web` não realizava o login automaticamente; agora, o terminal exibe o token de acesso.
- Limitar o valor de `max_tokens` dos provedores de chat completions à janela de contexto restante, evitando estouros de contexto e erros de parâmetros inválidos.

### Melhorias

- Otimizar o prompt de sistema padrão e as descrições das ferramentas integradas para impedir que o agente bloqueie tarefas em segundo plano, unificar as orientações sobre ferramentas entre os perfis e exibir detalhes dos resultados de ferramentas que antes não eram apresentados (modo de página buscada e total de correspondências do Grep).
- Armazenar em cache as linhas de mensagens renderizadas para manter o terminal responsivo em conversas longas.
- Manter apenas os turnos recentes no histórico da conversa e recolher as etapas mais antigas de cada turno para preservar a responsividade em sessões longas.
- Fazer com que o campo de entrada do chat web se ajuste ao conteúdo e adicionar um editor expansível para mensagens mais longas.
- Exibir a divisão de tarefas ocultas por status — concluídas, em andamento e pendentes — no painel de tarefas recolhido.

## 0.20.0 (2026-06-26)

### Funcionalidades

- Adicionar o modo shell à TUI. Digite `!` no campo de entrada para ativá-lo. Para executar comandos de longa duração em segundo plano, pressione Ctrl+B. Por exemplo, você pode executar `!gh auth login` para entrar na CLI do GitHub sem precisar abrir outro terminal.
- Adicionar a opção de CLI `--host`, permitindo que `kimi web --host` exponha o servidor à internet, com autenticação por token reforçada, limitação de taxa de requisições e outras medidas de segurança.
- Renderizar fórmulas matemáticas LaTeX em bloco (`$$…$$`) na interface web.

### Correções de bugs

- Corrigir uma falha na inicialização do Linux causada por um erro nativo de área de transferência não tratado.
- Corrigir a falha ao iniciar o daemon do servidor em segundo plano com `kimi web` e `/web` no Windows, apresentando `spawn EFTYPE` quando a CLI é instalada via npm/pnpm ou executada a partir do código-fonte. O script oficial de instalação do binário único não era afetado.
- Corrigir a perda repetida de foco da janela do terminal no Linux Wayland, que interrompia a entrada por IME.
- Impedir que perguntas na interface web sejam fechadas automaticamente após 60 segundos, permitindo que aguardem a resposta do usuário.
- Corrigir a perda silenciosa do contexto do Git pelos subagentes de exploração quando os comandos Git atingem o tempo limite ou o diretório não é um repositório.
- Corrigir o comportamento de Ctrl-C durante a compactação: primeiro, ele limpa um rascunho pendente do editor, em vez de cancelar a operação imediatamente.
- Corrigir os diretórios de trabalho dos servidores MCP quando as sessões são hospedadas pelo servidor web.
- Corrigir recarregamentos duplicados de snapshots de sessões na interface web integrada durante a ressincronização.
- Corrigir a ausência de reticências nas descrições de skills truncadas na listagem de skills do modelo.

### Melhorias

- Reformular `/plugins` como um único painel com abas:
  - **Installed** (gerenciar plugins instalados — ativar/desativar, remover, MCP, detalhes e recarregar).
  - **Official** (plugins do marketplace mantidos pela Kimi).
  - **Third-party** (plugins do marketplace de outros desenvolvedores).
  - **Custom** (instalar diretamente de uma URL do GitHub, URL de arquivo ZIP ou caminho local).

  Use `Tab` / `Shift-Tab` para alternar entre as abas.
- Exibir um diff linha por linha quando o agente editar ou gravar um arquivo no chat web.
- Exibir o conteúdo do plano e as opções de abordagem no cartão de revisão do plano ao sair do modo de planejamento na interface web.
- Exibir o progresso acumulado completo de um subagente em seu painel de detalhes, com resumos concisos das chamadas de ferramentas em vez de JSON bruto.
- `/reload` agora atualiza a visão do assistente sobre as skills dos plugins, fazendo com que as alterações nos plugins tenham efeito na sessão atual, sem exigir uma nova sessão.
- Substituir o truncamento silencioso de `AGENTS.md` por um aviso visível na barra de status da TUI e na interface web.
- Adicionar uma solicitação de confirmação antes de instalar plugins de terceiros.
- Exibir indicadores de atualização na aba Installed de `/plugins`. Agora, `Enter` instala a atualização disponível e `I` abre os detalhes do plugin.
- Adicionar um botão para copiar mensagens do usuário no chat web.
- Preservar os logs completos de saída das ferramentas quando as prévias forem truncadas e vincular as notificações de conclusão de tarefas em segundo plano à saída salva.
- Sincronizar alterações nos títulos das sessões entre todos os clientes conectados no modo servidor.
- Adicionar Ctrl+U e Ctrl+D como atalhos para subir e descer uma página no visualizador de saída de tarefas.
- Adicionar uma dica ao erro de limite de etapas por turno, indicando a opção de configuração `loop_control.max_steps_per_turn`.
- Reduzir o custo de redesenho durante o streaming de mensagens longas do assistente que contêm blocos de código.
- Implementar paginação da lista de sessões web por workspace, evitando que a primeira tela carregue todas as sessões de uma só vez.
- Impedir que a barra lateral de sessões da interface web seja renderizada novamente a cada token transmitido, melhorando o desempenho da renderização.
- Criar automaticamente os diretórios-pai ausentes ao gravar um arquivo.
- Melhorar a dica exibida ao colar imagens.

## 0.19.2 (2026-06-24)

### Funcionalidades

- Manter a possibilidade de reordenar workspaces por arrastar e soltar na barra lateral da interface web, com a ordem salva localmente. As sessões agora também passam para o topo de seu grupo assim que uma nova mensagem é recebida.
- Adicionar o atalho Alt+S ao seletor de modelos para trocar o modelo apenas na sessão atual, sem salvá-lo como padrão.
- Adicionar o atalho Ctrl+T para expandir e recolher uma lista de tarefas truncada.
- Adicionar `-c` como abreviação de `--continue`.

### Correções de bugs

- Corrigir o modo YOLO no aplicativo web, que aprovava automaticamente revisões de planos e acesso a arquivos sensíveis.
- Corrigir o comando de retomada, que não realinhava uma chamada de ferramenta interrompida no meio do histórico.
- Corrigir o problema em que a recuperação do histórico de entrada do compositor pelas teclas ↑/↓ não funcionava logo após a primeira mensagem de uma nova sessão.
- Corrigir linhas obsoletas que, ocasionalmente, deixavam caixas de entrada duplicadas após a redução de conteúdo alto.
- Corrigir imagens incorporadas que eram exibidas como sequências de escape inválidas no histórico da conversa.
- Corrigir blocos de código aninhados em itens de lista que ficavam em branco no chat web após o término da geração de uma resposta.
- Corrigir o comportamento inesperado da tecla Tab, que abria a lista de preenchimento automático de arquivos.
- Corrigir ações de cópia para a área de transferência na interface web quando servida por HTTP simples.
- Corrigir a ausência da opção de texto livre "Other" nas perguntas da interface web.
- Corrigir as ações de interrupção do chat web para que IDs de prompts obsoletos recorram ao cancelamento da sessão ativa.

### Melhorias

- Ler arquivos de texto grandes com uso de memória limitado e ler as linhas finais sem precisar percorrer o arquivo inteiro.
- Exibir o comando nos cartões de ferramentas Bash em execução e permitir expandi-lo com Ctrl+O antes da chegada do resultado.
- Permitir redimensionar a barra lateral e o painel de detalhes da interface web até a largura disponível da janela, mantendo as alças de redimensionamento acessíveis em janelas estreitas.
- Exibir sugestões de subcomandos após completar o nome de um comando slash com Tab.
- Exibir temporariamente uma dica no rodapé quando uma imagem for detectada na área de transferência, mostrando o atalho de colagem adequado à plataforma.
- Salvar o estado recolhido dos grupos de workspaces na barra lateral da interface web, mantendo-o após recarregar a página.
- Adicionar um indicador de modo de desenvolvimento à barra lateral da interface web para ambientes de desenvolvimento local.
- Otimizar a exibição das dicas de carregamento.

### Refatorações

- Reorganizar os componentes do aplicativo web em subdiretórios por área (`chat/settings/dialogs/mobile`) e atualizar os comentários com os caminhos dos componentes.
- Extrair várias partes do compositor para composables reutilizáveis.
- Extrair as funções auxiliares puras de renderização de turnos do painel de chat para um módulo próprio.
- Extrair o esboço beta da conversa (sumário) para um componente próprio.
- Extrair a renderização dos grupos de workspaces da barra lateral para um componente próprio.

## 0.19.1 (2026-06-23)

### Correções de bugs

- Corrigir a falha de editores ACP, como o Zed, ao tentar iniciar uma nova conversa.
- Corrigir a dessincronização dos indicadores de mensagens não lidas na barra lateral da interface web entre diferentes abas do navegador.
- Limpar todos os estados específicos de cada sessão quando ela for arquivada ou removida, evitando que sessões arquivadas deixem dados órfãos.

### Refatorações

- Centralizar o acesso ao `localStorage` do cliente web e dividir o armazenamento de estado raiz e a estrutura principal do aplicativo em composables específicos.

## 0.19.0 (2026-06-22)

### Funcionalidades

- Adicionar a possibilidade de incluir diretórios extras aos workspaces:
  - Use o comando `/add-dir <path>` para adicionar diretórios de trabalho extras à sessão atual ou salvá-los para o projeto.
  - Use `kimi --add-dir <path>` para adicioná-los durante a inicialização.
  - A configuração local do projeto agora é gerenciada em `.kimi-code/local.toml`; recomendamos adicioná-la ao seu `.gitignore`.
- Permitir que comandos em primeiro plano de longa duração e subagentes sejam movidos para tarefas em segundo plano com `Ctrl+B`, podendo ser acompanhados pelo painel `/tasks`.

### Correções de bugs

- Exibir bloqueios das políticas de segurança dos provedores em vez de tratá-los silenciosamente como turnos concluídos e impedir que a contagem de tokens do contexto caia para zero após uma resposta filtrada.
- Corrigir falhas nas solicitações aos provedores quando o histórico restaurado da conversa contém blocos de conteúdo de texto vazios.
- Detectar o formato real das imagens pelo conteúdo dos arquivos ao ler mídias, evitando que uma extensão de arquivo incompatível gere uma URL de dados rejeitada pela API do modelo.
- Corrigir a abertura rápida de uma janela de console vazia ao executar comandos no Windows.
- Impedir a exibição de indicadores de mensagens não lidas em sessões canceladas ou com falha na barra lateral da interface web.

### Melhorias

- Acelerar o carregamento de snapshots de sessões com um leitor direto do disco e uma proteção contra timeout das solicitações, mantendo o método anterior como alternativa para compatibilidade.
- Exibir nomes de branches mais longos no cabeçalho do chat web e mostrar o nome completo ao passar o cursor sobre ele.
- Manter o título da página web fixo, em vez de alterá-lo conforme o nome da sessão ou do workspace.
- Aprimorar a experiência de menção a arquivos.

### Refatorações

- Unificar a detecção do formato de imagens quando a identificação automática falhar.
- Centralizar o acesso ao `localStorage` do cliente web e desacoplar os estados de aparência e notificações em módulos dedicados.

## 0.18.0 (2026-06-18)

### Funcionalidades

- Adicionar filtros de sessões à barra lateral da interface web, permitindo filtrar pelo título e pela última mensagem enviada pelo usuário.
- Adicionar carregamento sob demanda de mensagens antigas ao rolar para cima na visualização de sessões do chat web.
- Adicionar uma variável de ambiente para limitar a concorrência do AgentSwarm durante a fase inicial de expansão, reduzindo a probabilidade de grandes grupos de agentes atingirem os limites de requisições dos provedores.

### Correções de bugs

- Corrigir o problema em que o aplicativo web carregava apenas as 20 sessões mais recentes.
- Corrigir a seleção de skills pelo menu slash na interface web, que enviava a mensagem imediatamente. Também permitir que a busca por comandos slash encontre skills por correspondência parcial nos nomes.
- Corrigir o menu slash da interface web, no qual o comando destacado deixava de permanecer visível durante a navegação por listas longas.
- Corrigir a exibição incorreta após arquivar a última sessão.
- Corrigir a descrição do comando slash de login na interface web para corresponder ao fluxo de autorização pelo navegador.

### Melhorias

- Reformular o diálogo de login OAuth da interface web para deixar a ordem das etapas mais clara.
- Exibir a versão atual nas configurações da interface web.
- Permitir que nomes e descrições longos de comandos slash na interface web quebrem linha sem ultrapassar os limites do menu.
- Adicionar a sugestão de uso de `/reload` às dicas exibidas após alterações em plugins.

## 0.17.1 (2026-06-17)

### Correções de bugs

- Corrigir a falha ao iniciar o comando `kimi web` em segundo plano.
- Impedir que o servidor local em segundo plano bloqueie o diretório a partir do qual foi iniciado.
- Impedir que o diálogo de login da interface web seja fechado ao clicar no fundo da janela.

### Melhorias

- Agrupar a lista suspensa do modelo padrão nas configurações da interface web por provedor.

## 0.17.0 (2026-06-17)

### Funcionalidades

- Adicionar o modo Kimi Code Web, que pode ser iniciado com `kimi web` ou `/web` na CLI, permitindo continuar sessões em uma interface de chat pelo navegador.

### Correções de bugs

- Exibir o erro de conexão original quando a atualização do token OAuth falhar após as tentativas internas, em vez de solicitar um novo login. As falhas na atualização do token não serão mais repetidas no nível do loop do agente.
- Restaurar o contador de turnos a partir dos eventos persistidos do loop ao retomar uma sessão, evitando que turnos após a retomada reutilizem IDs que já aparecem no histórico.

### Melhorias

- Omitir a exibição de TPS de depuração quando o fluxo de saída for curto demais para permitir uma medição confiável.

## 0.16.0 (2026-06-16)

### Funcionalidades

- Adicionar o comando integrado `kimi vis`, que abre o visualizador de sessões no navegador, apontando para as sessões locais. Oferece suporte às opções `--port` e `--host`, à opção `--no-open` e a links diretos para sessões específicas com `kimi vis <sessionId>`.

### Correções de bugs

- Impedir que provedores compatíveis com Anthropic leiam credenciais do shell do Anthropic disponíveis no ambiente e cabeçalhos personalizados.
- Corrigir o tratamento repetido da compactação quando o contexto continua acima do limite que bloqueia a execução.
- Impedir que o encerramento de uma sessão retome o agente ao interromper tarefas em segundo plano.
- Projetar os intervalos de reprodução de sessões com base nos registros de reprodução renderizados, em vez dos registros brutos persistidos.
- Fechar os fluxos de saída encapsulados quando os leitores com buffer forem destruídos.

### Melhorias

- Reduzir a altura máxima do painel lateral `/btw` de metade para um terço da altura do terminal.
- Aprimorar o estilo do painel de fila.
- Adicionar frequências configuráveis de exibição do banner, com estado de exibição armazenado localmente.

### Refatorações

- Remover a passagem redundante de contexto de logging das solicitações LLM.

## 0.15.0 (2026-06-15)

### Funcionalidades

- Adicionar uma tela de seleção com todas as sessões, incluindo busca por nome, navegação paginada e comandos de retomada prontos para copiar para a área de transferência, permitindo retomar sessões em outros diretórios de trabalho.
- Adicionar suporte a servidores MCP legados via SSE, além dos transportes stdio e HTTP streamable.

### Correções de bugs

- Recuperar sessões retomadas quando o resultado de uma chamada de ferramenta interrompida não tiver sido registrado.
- Parar de gravar marcadores de versão de retomada nos metadados persistidos do agente.
- Não transportar flags experimentais obsoletas ou desconhecidas, relacionadas a loop, tarefas em segundo plano, planejamento e modo YOLO, para arquivos de configuração migrados.
- Corrigir tipos incompatíveis no JSON Schema emitido pelo servidor MCP do Xcode 26.5 para garantir a compatibilidade com o Moonshot.

### Melhorias

- Manter os componentes da TUI dentro dos limites de terminais estreitos, ajustando a quebra de linha, compactando ou truncando linhas que ultrapassariam a largura de renderização.
- Orientar a CLI a exibir uma breve frase de status no mesmo idioma do usuário antes de chamadas de ferramentas que não sejam triviais.
- Estender a regra de mesmo idioma ao raciocínio do modelo, fazendo com que o thinking acompanhe o idioma do usuário, preservando códigos e termos técnicos em sua forma original.
- Ler arquivos de mídia usando os tipos detectados pelos cabeçalhos antes de recorrer às extensões dos arquivos.
- Priorizar a limpeza do texto do editor antes que Ctrl-C cancele um fluxo ativo.
- Recolher diretórios ocultos na solicitação de workspace e explicar como visualizá-los.
- Incluir o diretório da skill no bloco de contexto das skills carregadas, permitindo que o agente localize os recursos incluídos nela (scripts e templates) após sua ativação.
- Exibir a dica para alternar entre todas as sessões quando o diretório de trabalho atual não tiver nenhuma sessão.
- Esclarecer que os resumos de compactação devem ser apresentados na resposta final.
- Esclarecer as orientações do prompt para `AGENTS.md` e indicar arquivos de instruções que foram truncados.

### Refatorações

- Resolver os recursos dos modelos por meio de uma consulta estática, em vez de instanciar um provedor temporário.
- Desacoplar o acesso do agente às skills das implementações de registro específicas de cada sessão.
- Otimizar o sistema de empacotamento do npm.

## 0.14.3 (2026-06-14)

### Melhorias

- Atualizar os metadados dos modelos dos provedores antes de abrir o seletor de modelos.

## 0.14.2 (2026-06-12)

### Correções de bugs

- Corrigir as notificações repetitivas no iTerm2, enviando sequências de progresso do terminal apenas para terminais que oferecem suporte a elas.
- Exibir corretamente os registros de compactação concluídos e cancelados ao retomar uma sessão.
- Ignorar seções inválidas do `config.toml`, exibindo um aviso em vez de impedir a inicialização.

### Melhorias

- Transmitir a saída padrão (stdout) e a saída de erro (stderr) do Bash em primeiro plano enquanto os comandos ainda estão em execução.
- Permitir combinar `--auto`, `--yolo` e `--plan` com `--session` ou `--continue`, aplicando o modo solicitado à sessão retomada.
- Qualificar os nomes das sub-skills com o prefixo da skill principal e disponibilizar sub-skills como comandos slash com notação de ponto na TUI.
- Sincronizar adições e remoções de provedores do registro personalizado, além de chaves de registro renovadas, durante a atualização na inicialização.

## 0.14.1 (2026-06-12)

### Correções de bugs

- Cancelar turnos ativos durante o encerramento de sessões, impedindo que comandos shell em primeiro plano continuem em execução após a saída do modo prompt.
- Interromper tarefas em segundo plano por padrão quando as sessões forem encerradas.
- Impedir que solicitações interativas simultâneas do agente utilizem o agente ativo incorreto.
- Corrigir erros de encerramento prematuro de fluxos quando processos shell atingem o tempo limite ou são encerrados à força.
- Substituir conteúdos de áudio e vídeo não suportados por textos indicativos e anexar novamente as mídias dos resultados das ferramentas, em vez de descartá-las silenciosamente.
- Enviar os prompts de sistema do OpenAI Responses como instruções da solicitação.
- Propagar as substituições configuradas do ambiente de execução para os processos iniciados.
- Corrigir a leitura e a edição de arquivos via ACP em workspaces do Windows abertos por clientes de IDE.
- Exigir que as chamadas de ferramentas do AgentSwarm sejam executadas isoladamente em uma resposta do modelo.

### Melhorias

- Adicionar suporte em tempo de execução para atualizações dinâmicas de servidores MCP, skills de referência, timestamps de reprodução e uploads de arquivos via Node.
- Adicionar a opção YOLO ao iniciar tarefas do swarm a partir do modo Manual.
- Aprimorar as skills integradas.
- Encontrar comandos slash por seus aliases no preenchimento automático — ao digitar `/clear`, agora será sugerido `new (clear)`.
- Permitir que descrições longas de comandos e skills no menu de preenchimento automático quebrem para uma segunda linha, em vez de serem cortadas.
- Exibir um banner com dicas abaixo do painel de boas-vindas durante a inicialização.

## 0.14.0 (2026-06-10)

### Funcionalidades

- Adicionar o evento de hook `Interrupt`, acionado quando o usuário interrompe um turno (por exemplo, ao pressionar Esc), permitindo que os hooks detectem a interrupção em vez de permanecerem presos em um estado de execução.

### Correções de bugs

- Preservar as imagens geradas pelas ferramentas ao utilizar provedores de chat completions compatíveis com OpenAI.

## 0.13.1 (2026-06-10)

### Correções de bugs

- Impedir a criação de forks de sessões durante turnos ativos e consolidar as definições do protocolo de comunicação em um pacote interno compartilhado.
- Corrigir o Kimi Datasource para utilizar as credenciais OAuth correspondentes e o endpoint de serviço do ambiente ativo do Kimi Code.
- Corrigir o texto do marcador de objetivo, que ultrapassava a largura do terminal.

### Melhorias

- Adicionar suporte ao Claude Fable 5 no provedor Anthropic.
- Adicionar um seletor interativo de ações para desfazer e mensagens mais claras sobre os limites de desfazer.
- O modo YOLO não solicita mais confirmação antes de gravar ou editar arquivos fora do diretório de trabalho.
- Esclarecer os prompts de skills ativas para que as skills carregadas não sejam mais representadas como lembretes do sistema.
- Reforçar as orientações sobre o uso das ferramentas de arquivos, direcionando edições incrementais para a ferramenta Edit.

## 0.13.0 (2026-06-10)

### Funcionalidades

- Adicionar temas de cores personalizados. Defina sua própria paleta em um arquivo JSON no diretório `~/.kimi-code/themes/` ou gere uma usando o comando de skill integrado `/custom-theme`.
- Adicionar o comando `/import-from-cc-codex` para importar instruções, skills e configurações MCP selecionadas do Claude Code e do Codex.
- Exibir atualizações disponíveis para plugins no marketplace.

### Correções de bugs

- Corrigir builds do Windows e inicializações em ambiente de desenvolvimento que poderiam falhar quando os binários dos pacotes fossem resolvidos como atalhos de comando (shims).
- Corrigir o login por dispositivo para manter a URL e o código visíveis quando não for possível abrir o navegador.

### Melhorias

- Esclarecer o progresso agrupado dos subagentes com detalhamento dos status ativos e do tempo decorrido.
- Limitar a exibição de mensagens na fila a uma única linha, adicionando reticências quando o conteúdo ultrapassar a largura do terminal.

## 0.12.1 (2026-06-09)

### Correções de bugs

- Permitir que entradas experimentais obsoletas permaneçam no arquivo de configuração sem impedir a inicialização.
- Repassar o nível de esforço de raciocínio `xhigh` nas solicitações de chat completions compatíveis com OpenAI.

## 0.12.0 (2026-06-09)

### Funcionalidades

- Adicionar o comando `/swarm` para executar grupos de agentes com acompanhamento do progresso em tempo real e novas tentativas que levam em consideração os limites de requisições.
- Disponibilizar objetivos, perguntas em segundo plano e descoberta de sub-skills sem a necessidade de habilitar recursos experimentais.
- Respeitar as variáveis de ambiente padrão `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`, incluindo proxies SOCKS, para todo o tráfego de saída.
- Adicionar suporte a instalações via Homebrew.
- Habilitar a microcompactação por padrão. Para desativá-la, use `/experiments`.

### Correções de bugs

- Corrigir o roteamento de skills slash no ACP, a leitura do contexto de inicialização, casos específicos de arquivos e permissões, o tratamento de eventos dos subagentes e as mensagens de edição de arquivos desatualizados.
- Corrigir o comportamento de retomada de objetivos, restaurando o estado dos objetivos a partir dos registros do agente.
- Corrigir a exibição do texto de thinking e da saída de ferramentas dos subagentes.
- Corrigir a incompatibilidade do diretório de trabalho das sessões no Windows, causada por separadores de caminho inconsistentes.
- Corrigir a borda do painel de status `/mcp`, que era quebrada por erros de servidores MCP com várias linhas. Agora, esses erros são agrupados em uma única linha.
- Detectar instalações do Git Bash feitas via Scoop e outros shims do Git no Windows.
- Exibir o erro original quando uma migração falhar.
- Permitir sair do seletor de sessões da inicialização pressionando Ctrl-C ou Ctrl-D repetidamente.

### Melhorias

- Remover o limite de compactação automática por turno, permitindo que conversas longas continuem sendo compactadas em vez de falharem prematuramente.
- Aprimorar o tratamento de resultados no modo de objetivos com mensagens de acompanhamento, pausas mais seguras em caso de erros e uma exibição mais clara do histórico na TUI.
- Exibir os cartões de plano completos diretamente e remover o atalho de teclado do cartão Plan.
- Quebrar comandos shell longos de linha única nas solicitações de aprovação, mantendo o comando completo visível.
- Reformular o preenchimento automático de referências a arquivos na TUI.
- Carregar as skills de usuário específicas do Kimi e as instruções globais do agente a partir de `KIMI_CODE_HOME`, quando essa variável estiver definida.

## 0.11.0 (2026-06-05)

### Funcionalidades

- Adicionar a descoberta experimental de sub-skills, controlada pela variável de ambiente `KIMI_CODE_EXPERIMENTAL_SUB_SKILL`. Inclui o pacote integrado `sub-skill` (`sub-skill.review`, `sub-skill.consolidate`) para inventariar e consolidar skills em grupos hierárquicos.
- Adicionar as seguintes variáveis de ambiente:
  - `KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P` — parâmetros de amostragem aplicados globalmente a qualquer provedor `kimi` (não vinculados a `KIMI_MODEL_NAME`).
  - `KIMI_MODEL_THINKING_KEEP` — encaminhamento do parâmetro de thinking preservado do Moonshot (`thinking.keep`), injetado somente quando o Thinking estiver ativado.
  - `KIMI_CODE_NO_AUTO_UPDATE` (alias legado `KIMI_CLI_NO_AUTO_UPDATE`) — desativa completamente a verificação prévia de atualizações (sem verificações, instalação em segundo plano ou solicitações de confirmação).
- Exibir skills integradas como comandos slash diretos e agrupá-las antes dos comandos de skills externas.

### Correções de bugs

- Corrigir o preenchimento automático de comandos slash para permitir o envio do texto de objetivos quando o cursor estiver posicionado antes de um texto existente.
- Corrigir o enfileiramento de objetivos para que tentativas malsucedidas de promoção não causem perda ou duplicação de tarefas na fila.
- Corrigir o gerenciamento da fila de próximos objetivos durante a edição ou colagem de objetivos enfileirados.
- Solicitar confirmação antes de iniciar objetivos no modo YOLO, permitindo que os usuários mudem para o modo Auto em tarefas executadas sem supervisão.
- Exibir mensagens concisas de erros de filtragem dos provedores quando as respostas forem bloqueadas antes de qualquer conteúdo visível.
- Exibir "comando desconhecido" em vez de "argumentos demais" quando um subcomando inválido for informado.
- Limitar o nível de esforço de thinking `xhigh` e `max` do OpenAI Chat Completions a `high`, a menos que o modelo ofereça suporte a `xhigh` em `v1/chat/completions`.
- Preservar o nível de esforço de thinking durante a compactação de conversas longas.
- Atualizar os metadados dos modelos dos provedores quando suas capacidades forem alteradas, mesmo que os IDs dos modelos permaneçam iguais.

### Melhorias

- Exibir a confirmação de próximos objetivos com o mesmo destaque visual utilizado nas mensagens do ciclo de vida dos objetivos.
- Iniciar próximos objetivos imediatamente quando não houver um objetivo ativo aguardando conclusão.
- Oferecer suporte a edições com várias linhas ao gerenciar próximos objetivos.
- Utilizar um timeout fixo de 30 minutos para subagentes e exibir instruções concisas para retomá-los quando o tempo limite for atingido.
- Destacar os subcomandos da fila de objetivos durante a digitação de comandos slash.

## 0.10.1 (2026-06-05)

### Bug Fixes

- Fix a crash when starting a goal in the TUI.

## 0.10.0 (2026-06-04)

### Features

- Users now can prepare several goals for the agent to work on sequentially. The agent will pick up the next goal from the queue once the current goal is completed. Use `/goal next <objective>` to queue a goal and `/goal next manage` to review and change the queue interactively.
- Add the built-in `update-config` skill — you can now have Kimi edit its own config files.
- Add persistent experimental feature toggles and a TUI panel that applies confirmed changes by reloading the current session.
- Add `/reload` to reload the current session and apply updated config files, plus `/reload-tui` to reload only TUI preferences.
- Add a doctor command for validating Kimi Code configuration files.

### Bug Fixes

- Normalize malformed Responses stream rate limit errors as provider rate limit failures.
- Keep managed OAuth credentials scoped to their configured authentication and API endpoints.
- Stop carrying active and queued goals into forked sessions.
- Fail early when Git Bash is missing on Windows before starting CLI sessions.
- Refresh the update target before showing foreground update prompts so the displayed version matches the install.
- Point session error diagnostics to the `/export-debug-zip` command.
- Set terminal tab titles without renaming the running process.

### Polish

- Start automatic background updates as soon as startup's fresh update check finds a newer version.
- Set the CLI process title to kimi-code during startup.
- Lowercase the stale file content message in edit tool errors.

### Refactors

- Ensure Nix-packaged CLI builds can find ripgrep and fd.

### Other

- Document the Git Bash prerequisite for Windows installs.

## 0.9.0 (2026-06-03)

### Features

- Add the `kimi acp` subcommand: kimi-code now speaks [Agent Client Protocol 0.23](https://agentclientprotocol.com/) over stdio so IDEs (Zed, JetBrains AI Chat, custom clients) can drive sessions directly — coverage matrix, Zed configuration and breaking pre-release notes are in [kimi acp Subcommand Page](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html).
- Add `/btw` for side-channel conversations without steering the active main turn, and allow `/btw` to open the side-channel panel before entering a question.

### Bug Fixes

- Fix external editor (Ctrl+G) on Windows by removing `/bin/sh` dependency and using platform-aware shell quoting for temp file paths.
- Use the OpenAI completion token field required by newer Chat Completions models.
- Use configured model output limits for completion token caps.
- Fix goal budget tool schemas for OpenAI-compatible providers.
- Resume saved subagents lazily when they are accessed.

### Polish

- Unify the interaction and visuals across TUI dialogs and selectors.
- Log enabled experimental flags at startup.

### Refactors

- Allow SDK runtime creation to use a separate RPC client while preserving local CLI startup.

## 0.8.0 (2026-06-02)

### Features

- Add experimental goal mode for longer tasks that need more than one turn. Turn it on with `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` before you start Kimi.

  Use `/goal <objective>` in the TUI when you want Kimi to keep working on one task across turns. For example:

  ```text
  /goal Fix the failing checkout test
  ```

  Kimi shows the goal in the TUI and keeps progress visible while it works. Use `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal replace <objective>` to manage the goal. This feature is still experimental. Try it and tell us what would make it more useful.
- Add `kimi provider` CLI subcommand with `add`, `remove`, `list`, and `catalog list` / `catalog add` actions, so providers from a custom registry (api.json) or the public models.dev catalog can be imported and managed without launching the TUI.
- Add background structured questions so agents can continue while waiting for user answers.
- Add background automatic upgrades, which can be disabled in tui.toml.
- Add `/undo` slash command to withdraw the last prompt from conversation history, and keep replay records in sync when a prompt is undone.
- Add a `kimi upgrade` command for manually checking and upgrade Kimi Code CLI.
- Add approval lifecycle hook events for observing pending and completed permission prompts.
- Allow subagents to use custom tools registered on their parent agent.
- Allow glob searches to target explicit absolute paths outside the workspace.

### Bug Fixes

- Fix cross-provider replay failures from incompatible tool call IDs and unsigned Claude thinking history.
- Fix custom registry provider handling during re-import. Prevent loss of multi-provider entries and remove stale providers along with their model aliases and default model references.
- Fix tool output preview rendering: trim trailing empty lines, append ellipsis to multi-line Bash command headers, and truncate long single-line output by visual wrapped lines instead of raw newline count.
- Fix slash-activated skills not being recognized by the model due to missing system reminder wrapper.
- Fix a crash in the `/sessions` picker on very narrow terminals by clamping every rendered line to the terminal width.
- Normalize glob patterns before brace expansion to prevent incorrect path matching.
- Prevent modified keyboard release sequences from appearing after exiting the CLI.
- Fix Git Bash path detection on Windows by also searching `usr\bin\bash.exe` locations, which is where bash lives in many Git for Windows installations where `bin\bash.exe` does not exist.

### Polish

- Show MCP server summary in the welcome panel and add configuration hints in the /mcp command output.
- Point users to `/provider` instead of the removed `/connect` command in the welcome screen and the no-models-configured hint.
- Append the current todo list as markdown to compaction summaries before writing them to history.
- Show the full model name in the footer status bar instead of truncating the provider prefix.
- Remind the model to refresh TodoList during long-running tasks and strengthen TodoList progress-tracking guidance.
- Replace chalk named color with theme-aware hex in session-directory warning.

### Refactors

- Consolidate background task management under the agent background runtime.

## 0.7.0 (2026-06-02)

### Features

- Add `/provider` command for managing AI providers, support custom registry imports, and introduce a tabbed model selector. It replaces the deprecated `/connect` command — use `/provider` instead.
- Render scheduled reminders distinctly in the TUI, expose cron fired events to SDK clients, and report cron fire times with local timezone offsets.
- Add `KIMI_MODEL_ADAPTIVE_THINKING` (and a matching `adaptive_thinking` model-alias field) to force adaptive thinking (`thinking: { type: 'adaptive' }`) on or off, overriding the Anthropic model-name version inference. This lets custom-named compatible endpoints that back an adaptive-capable model opt in even when the model name does not encode a parseable Claude version.

### Bug Fixes

- Report truncated compaction summaries clearly and apply valid completion token budgets across supported providers.
- Fix glob pattern backslash escaping and include match count in truncation messages.

### Polish

- Clarify Kimi Platform API key login labels and prompt details.
- Polish a small TUI visual interaction.

## 0.6.0 (2026-05-29)

### Features

- Add a `KIMI_MODEL_*` environment-variable channel that lets you run Kimi Code against a specific model (provider type, base URL, API key, context size, capabilities, and thinking settings) without editing `config.toml`.
- Install plugins directly from GitHub repository URLs, and surface each install's origin and trust level (kimi-official, curated, third-party) in the plugin manager.

### Bug Fixes

- Show the real terminal status of background agents in the transcript so lost, failed, and killed ones no longer appear as completed, and include the resume agent id and recovery instructions in the failure notification so the model can resume reliably.
- Recover from provider model token limit errors during long conversations.
- Automatically retry when a model response stream is dropped mid-flight (a `terminated` error) instead of failing the turn.
- Handle context overflow errors consistently across provider responses.
- Back off failed compaction retries by a fixed slice of the model context window.
- Fix the native self-updater reporting a successful update when the install command actually failed.
- Project persisted hook and blocked prompt messages into model context.
- Keep blocked prompt hook conversations available to subsequent model turns.
- Fix footer leaking onto the terminal when resuming a non-existent session.
- Fix automatic ripgrep installation when temporary files are on another filesystem.

### Polish

- Remove the default per-turn step limit of 1000. Users can still set `max_steps_per_turn` in config to enforce a custom limit.
- Support querying sessions by sessionId or workDir in listSessions, and show a helpful cd command when resuming a session from a different working directory.
- Expand the footer's rotating tips to surface more commands and shortcuts, featuring newer and important ones more prominently.
- Improve the usage information display in the TUI.
- Restrict plugin trust badges to Kimi-hosted plugin CDN URL patterns.
- Clarify subagent and background task stop messages as user-initiated.
- Align the datasource plugin with the generic two-tool workflow.

### Refactors

- Introduce `ModelProvider` interface and `SingleModelProvider` to decouple `Agent` from `ProviderManager`.
- Split `RuntimeConfig` into `Kaos` and `ToolServices` and update all references accordingly.
- Slim the LLM diagnostic logs with fewer, more compact fields.
- Relocate shared tool service typing to the tool support layer.

## 0.5.0 (2026-05-28)

### Features

- Add scheduled tasks:

  You can now ask the agent to remind you at a specific time, run a task on a recurring cron schedule (for example, check a deploy every 5 minutes or run a daily report every weekday at 9am), or come back on its own in a few minutes to continue what it was doing.

  Schedules use the standard 5-field cron syntax.

- Add `/auto` slash command and `--auto` CLI flag for auto permission mode.
- Show file content and diff in Write and Edit approval prompts, and open them in a dedicated full-screen viewer on ctrl+e instead of expanding inline.

### Bug Fixes

- Fix compaction to handle edge cases where no messages are compactable and improve retry logic.
- Fix official datasource tools to preserve complete responses and write returned result files.
- Fix migration mapping the legacy `default_yolo` key to the dead `yolo` field instead of `default_permission_mode`.

### Polish

- Add a clickable changelog link to the update prompt.
- Show the full Bash command when expanding a Bash tool card with `ctrl+o`. The header still truncates long commands at 60 chars, but the expanded view now reveals the complete multi-line command above the output.
- Shorten the session title written to the terminal window/tab from 80 to 32 characters so long first messages and pasted content no longer stretch the tab bar past readable width.
- Cap the inline todo panel at five rows and show a `+N more` indicator so long task lists no longer fill the screen.
- Clarify plugin manager keyboard shortcuts and show plugin state changes inline.
- Report discovered plugin skills in plugin manager summaries.
- Offload large base64 media payloads from `wire.jsonl` into external blob files to reduce wire size and memory pressure during session replay. Includes an in-memory read-through cache on `BlobStore` so repeated rehydration avoids redundant disk reads.
- Wrap long question, body, and option text in the AskUserQuestion dialog instead of truncating with an ellipsis. The question prompt, body description, option label, option description, and submit-tab review entries now flow onto multiple lines with a hanging indent.

### Refactors

- Refactor TUI code structure.

## 0.4.0 (2026-05-27)

### Features

- Add user-global plugin installation, interactive plugin management, plugin-provided skills, and plugin-owned MCP servers.
- Expand folded paste markers on second paste.
- Rework tool permissions: reads outside cwd no longer prompt, session approvals match the exact call, and path-based rules are case-insensitive.
- Add `/export-debug-zip` slash command to export the current session as a debug ZIP archive directly from the TUI.
- Add `/export-md` slash command to export the current session as a Markdown file.

### Bug Fixes

- Prevent the TUI from crashing when pull request lookup fails during startup.
- Fix thinking spinner leaking past turn end when an empty thinking delta creates an orphaned thinking component.
- Show the original session resume command after forking a session.
- Restrict plugin zip installs to manifests at the archive root or a single wrapper directory.
- Route session-tagged log entries exclusively to the session sink instead of duplicating them to the global sink. Consistently omit stable main-agent context keys from all session log lines that carry `agentId=main`.

### Refactors

- Refactor TUI resume replay logic.
- Use one retry classification for transient LLM failures across regular turns and compaction.

### Other

- Enhance `kimi export` to include more diagnostic information in the manifest.

## 0.3.0 (2026-05-26)

### Features

- `/logout` now opens a picker so you can choose which provider to log out of, instead of always logging out the one tied to the current model. The current provider is highlighted by default, so pressing Enter matches the previous behavior. The command is also available as `/disconnect`.
- The `openai` provider now works out of the box for OpenAI-compatible reasoner models: it auto-detects thinking fields in responses (`reasoning_content` / `reasoning_details` / `reasoning`) and auto-injects `reasoning_effort` when history contains prior thinking. DeepSeek, Qwen, One API and other gateway-fronted services no longer need a hand-set `reasoning_key`, which remains available as an explicit override for non-standard gateways.

### Bug Fixes

- Prevent running the `/model` and `/sessions` slash commands while streaming or compacting context.
- Preserve catalog-declared interleaved reasoning fields for OpenAI-compatible models configured through `/connect`.
- Fix API key input dialog showing a masked dot in empty state.
- Fix user skills in `~/.agents/` not being loaded.
- Restore real-time token display for running subagents in the TUI.
- Hide the todo panel on resume when all todos are already completed.
- Always emit a paired tool result when a tool returns a malformed or missing result, preventing the next request from failing with a missing tool_call_id error.
- Fix Plan mode session resets so new sessions no longer fail after plan review rejection and continue receiving events after setup errors.
- Exit promptly when the controlling terminal goes away. The TUI now handles `SIGHUP` / `SIGTERM` and stdout/stderr `EIO` / `EPIPE` / `ENOTCONN` errors, preventing leftover `kimi` processes that pin a CPU core after the parent shell or multiplexer dies unexpectedly.
- Avoid overly small local completion caps that can truncate reasoning before summaries are produced.

### Refactors

- Make `AgentRecords` hold the `Agent` instance directly and inline the restore dispatch logic.

### Other

- Improve the Write tool UX.

## 0.2.0 (2026-05-26)

### Features

- Add a `/connect` command that configures a provider and model from a model catalog.
- The `/connect` provider and model pickers now support type-to-search filtering, and long lists are paginated. The `/model` picker is also paginated when many models are configured.
- Add `Ctrl-J` as an additional shortcut for inserting new lines in the TUI prompt.
- Add wire record migration handling during session replay.
- Migrate user skills from `~/.kimi/skills/` to `~/.kimi-code/skills/` during the first-launch migration; existing target skills are kept.
- Emit session resume hint as a structured meta message in stream-json output format.

### Bug Fixes

- Report the macOS product version in OAuth device information instead of the Darwin kernel version.
- Correct the `X-Msh-Platform` header value to `kimi_code_cli`.
- Clarify the prompt-mode error when no model is configured by pointing users to the login flow.
- Hide the empty current session from the sessions picker while keeping other empty sessions visible.
- Stop mentioning OAuth credentials in the migration UI — they are never migrated, so the previous "needs /login" notice misread as a failure. OAuth-only installs no longer trigger the migration screen.
- Surface API-provided error messages during feedback, usage, login, and model setup failures.
- Persist model selections from the terminal UI to the default configuration, and honor the configured default thinking state for new sessions.
- Retry compaction responses that do not contain a summary before updating conversation history.
- Avoid CPU spikes from large streamed tool arguments and coalesce high-frequency streaming UI updates.
- Resume sessions with a newer wire protocol version instead of failing. A warning is now shown in the TUI and records are replayed without migration.
- Warn tmux users when extended key settings may prevent modified Enter shortcuts from working.
- Let Kimi requests use the remaining context window for completion tokens by default while keeping explicit environment limits as hard caps.

### Refactors

- Flatten tool call data by inlining tool names and arguments at the top level, and limit legacy record migration so it only rewrites matching tool call payloads.
- Move wire metadata handling into the record layer and keep persistence backends limited to storage operations.

### Other

- When no models are configured, `/model` and the welcome panel now point users to `/login` (for Kimi) and `/connect` (for other providers).
