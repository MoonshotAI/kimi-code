# Agentes e Subagents

Toda sessão no Kimi Code CLI é dirigida pelo **Agente principal**. O Agente principal entende a inteção do usuário, planeja seus passos, chama ferramentas, e, quando necessário, despecha **subagentes** para lidarem com subtarefas mais específicas — por exemplo, explorar uma codebase desconhecida, revisar múltiplas implmentações em paralelo, ou planejar uma grande refatoração sem tocar no contexto principal.

Um subagente recebe uma descrição de tarefa do Agente principal, trabalha em seu própio contexto isolado, então retorna suas conclusões. Ele não se comunica diretamente com o usuário, e seu raciocíninio intermediário e os registros de chamada de ferramentas não se misturam ao histórico do Agente principal.

## Subagentes embutidos

Kimi Code CLI inclui três subagntes embutidos, prontos para uso, cada um voltado para um formato de tarefa diferente:

- **`coder`**: O subagente padrão — um assistente de engenharia de software de uso geral que pode ler e escrever arquivos, executar comandos, pesquisar códigos e implementar mudanças concrertas.
- **`explore`**: Dedicado a exploração de codebase, performa apenas operações de somente leitura e não modifica nenhum arquivo. Ideal para pesquisar, ler e resumir rapidamente um repositório sem tocar nos arquivos.
- **`plan`**: Dedicado ao planejamento de implementações e design de arquitetura; até os comandos de shell não são disponíveis, mantendo o foco em "descobrir como fazer algo" ao invés de "realmente fazê-lo."

Um subagente `coder` compartilha a maior parte do conjunto de ferramentas do Agente principal: ele pode executar os comandos de shell em segundo plano, manter listas de tarefas, entrar em modo Plan e invocar as Habilidades do Agente. Subagentes embutidos não podem despachar outros subagentes. Por padrão, um agente personalizado herda as listas de permissões de deligação embutidas (`coder`, `explore`, `plan`), cujos membros não podem despachar mais nada, então, cadeias de delegação sempre terminam — geração recursiva ilimitada é impossível sem consentimento explícito. Um agente personalizado pode optar por entar em cadeias mais profundas declarando uma lista de permissões explícita de [`subagents`](#agente-file-format). Se um subagente terminar seu turno enquanto que tarefas de segundo plano ainda estão correndo, sua execução apenas relata conclusão depois que essas tarefas terminam, então os pais recebem os resultados após a conclusão do trabalho subjacente.

## Como Invocar

Subagentes são agendados automaticamente pelo Agente pirncipal — baseado na complexidade da tarefa, no consumo de contexto e na independência da subtarefa, eles são despachados no momento certo sem que o usuário precise especificar um.

Cada despache é apresentado no terminal como uma aprovação de pedido (a não ser que corresponda a uma regra de permissão ou o modo Perguntar Quando Necessário esteja ativo), dando a você uma chance de revisar a descrição da tarefa. Você também pode instruir o Agente principal diretamente na conversa a utilizar um subagente específico, por exemplo: "Use explore para mapear arquivos importantes antes de fazer qualquer mudança."

Subagentes conseguem serem executados em segundo plano: resultados são retornados automaticamente ao Agente principal após conclusão, sem necessidade de sondagem manual. Você também pode chamar de volta uma instância de subagente existente para continuar a mesma tarefa.

## Isolamente de Contexto e Custo de Recurso

Cada subagente tem uma janela de contexto completamente independente. Ele pode apenas ver a descrissão de tarefa explicitamente passada pelo Agente principal e não pode ver o histórico de conversa do Agente principal. Os própios registros de raciocínio e de chamadas de ferramentas do subagente não retornam ao fluxo principal; apenas o resultado final aparece no contexto do Agente principal.

Essa isolação oferece dois benefícios:

- **O contexto do Agente principal permanece enxuto** e não é preenchido por grandes volumes de registros exploratórios durante sessões longas.
- **Múltiplos subagentes podem ser executados em paralelo** sem interferir uns nos outros.

Note que cada subagente consome tokens de modelo de forma independente. Para tarefas simples, não há necessidade de despachar um subagente — o Agente principal lida com eles de maneira mais econômica.

## Herança de Permissões

As regras de permissõe de subagentes são herdadas do Agente principal: "sempre permitir" regras que o Agente principal tenha aceitado através de `/permission`ou propagar automaticamente, por meio de uma caixa de diaálogo de aprovação, para todos os subagentes que ele despacha, então, subagentes não precisam reaprovar os mesmos tipos de chamadas de ferramentas. A ferramente de `Agent`em si são permitidas por padrão, permitindo que o Agente principal delegue múltiplas vezes sem interromper o usuário.

Se você precisar que um tipo específico de ferramenta fique permanentemente indisponível dentro de subagentes, restrinja a regra de permissão correspondente no Agente principal.

## Agentes Personalizados

Além dos três subagentes embutidos, você pode definir seus próprios agentes como arquivos Markdown. Cada arquivo descreve um agente: o frontmatter (metadata YAML no top do arquivo) declara o seu nome, descrição e acesso a ferramentas, e o corpo do arquivo é o seu sistema de prompt. Agentes personalizados podem ser delegados como subagentes — o Agente principal os detetcta automaticamnete junto com os que já vêm integrados — ou selecioandos como Agentes principais na inicialização.

### Localizações dos Agentes

Kimi Code CLI escobre arquivos de agentes por escopo; escopos mais específicos têm maior prioridade: **Explicit (`--agent-file`) > Project > Extra > User > Plugin > Built-in**. Quando dois arquivos definem o meos `nome`, o escopo de maior prioridade ganha. Cada diretório é examinados recursivamente em busca de arquivos `.md`.

**Nível de usuário** (aplica a todos os projetos):
- `$KIMI_CODE_HOME/agents/`(padrão: `~/.kimi-code/agents/`)
- `~/.agents/agents/`

O diretório de agente de usuário específico do Kimi é movido com `KIMI_CODE_HOME`,enquanto o diretório genérico `~/.agents/agents/` permanece no diretório home real do SO, para que possa ser compartilhado entre ferramentas.

**Nível de projeto** (diretório raíz = o diretório mais próximo contendo `.git`, pesquisando em direção ascendente a partir do diretório de trabalho):
- `.kimi-code/agents/`
- `.agents/agents/`

**Diretórios extras**: Declarados através de `extra_agent_dirs` no nível superior do `config.toml`:

```toml 
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

**Nível do plugin**: diretórios declarados no campo `agents` do manifesto de um plugin habilitado (quando omitido, o diretório `agents/` sob a raiz do plugin é detectado automaticamente); veja [Agentes de Plugin] (./plugins.md#plugin-agents). Agentes de plugin superam em hierarquia apenas os agentes integrados.

**Agente integrados** são distribuídos com o CLI e possuem a prioridade mais baixa. Um arquivo descoberto em um diretório não substitui um Agente integrado de mesmo nome, a não ser que seu frontmatter declare `override: true`. Um arquivo carregado através de `--agent-file` é tratado como uma intenção de lançamento explícita, pode substituir um Agente integrado de mesmo nome, tem precedência sobre qualquer escopo de diretório e aplica-se apenas à execução atual. Separadamente, $KIMI_CODE_HOME/SYSTEM.md` permanentemente substitui o prompt de sistema padrão do Agente principal (não fazendo parte da descoberta de arquivos via agente); suas interações de precedência são abordadas na seção SYSTEM.md abaixo. 

::: aviso sobre modelo de Confiança
Arquivos de Agentes são configurações de prompt, e arquivos de nível de projeto vêm do prórpio repositório — incluindo repositórios que você acabou de clonar e não confia ainda. Um arquivo com escopo definido para o projeto pode assumir completamente o controle de um agente integrado: nomeando-o como `agent.md` com `override: true` substitui **todo o prompt do sistema do Agente principal padrão**, e `coder.md` com `override: true` substitui o tipo de subagente padrão. Ao contrário do conteúdo de `AGENTS.md` — o qual é injetado no prompt como dados de referência — um arquivo de substituição *é* o prompt do sistema, e o arquivo se, uma lista de `tools` mantém todas as ferramentas. Analise `.kimi-code/agents/` e `.agents/agents/` em repositórios desconhecidos com o mesmo cuidado que você aplicaria aps scripts antes de executar o Kimi Code dentro deles.
:::

### Formato de Arqruivo dos Agentes

Um arquivo de agente é um Markdown simples com um bloco de frontmatter:

```markdown
---
name: reviewer
description: Revisor de código rigoroso que relata achados classificados por gravidade.
whenToUse: Revisões de código e verificações de PR
override: false
tools:
  - Read
  - Grep
  - Glob
  - mcp__github__*
disallowedTools:
  - Bash
---

Você é um revisor de código rigoroso. Analise o diff e, em seguida, relate as descobertas agrupadas por gravidade…
```

| CAmpo | Obrigatório | Descrição |
| --- | --- | --- |
| `name` | não | Identificador único em kebab-case. Usa o nome do arquivo sem a extensão por padrão (`review.md` → `review`); Um arquivo cujo nome resolvido esteja ausente ou não esteja no formato kebab-case é ignorado, com a emissão de um aviso |
| `description` | sim | O que o agente faz. Exibido ao Agente principal quando este seleciona um subagente; portanto, redija-o de modo a orientar as decisões de delegação |
| `whenToUse` | não | Dica adicional descrevendo quando o agente deve ser utilizado |
| `override` | não | Se este arquivo pode substituir um Agente interno de mesmo nome. Recorre a `false`; `--agent-file` já está explícito e não requer este campo |
| `tools` | não | Lista de permissões de nomes de ferramentas, como `Read` or `Bash`; As ferramentas MCP são combinados com os padrões glob, como `mcp__github__*`. Aceita uma lista YAML ou uma string separada por vírgulas (`tools: Read, Grep`). Omita para permitir todas as ferramentas; um único `*` também permite todas as ferramentas; uma lista vazia (`tools: []`) desativa todas as ferramentas |
| `disallowedTools` | não | Lista de bloqueio com a mesma sintaxe e regras de correspondência, aplicada após `tools` |
| `subagents` | não | Lista de permissão de nomes de subagentes para os quais este agente pode delegar, com a mesma sintaxe de `tools` (Lista YAML ou string separada por vírgulas). Omita para herdar a lista de permissões do agente padrão (padrão integrado: `coder`, `explore`, `plan`, cujos membros não podem delegar mais adiante, de modo que as cadeias herdadas sempre terminam); um único `*` permite todos os tipos. A lista de permissões efetiva do agente principal também inclui todos os agentes personalizados descobertos; portanto, os agentes personalizados permanecem delegáveis ​​por padrão |

As ferramentas integradas e as ferramentas do usuário correspondem exatamente, nome case-sensitive; entradas que começam com `mcp__` correspondem a ferramentas MCP como padrões globs. Três formatos de entradas nunca correspondem a nada e são reportadas com um aviso quando o perfil entra em vigor:  um caractere curinga fora de um padrão `mcp__` (um mero `*` no `disallowedTools` desativa nada), um `mcp__` literal que não é um nome `mcp__<server>__<tool>` completo (`mcp__github` não corresponde a nada — use `mcp__github__*` para o servidor inteiro), e um nome que nenhuma ferramenta registrada ou integrada possui (geralmente um erro de digitação, como `read` em vez de `Read`).

O corpo é o prompt de sistema do agente, e é renderizado como um modelo sempre que o prompt é construído: espaços reservados `${var}` substituem valores de contexto em tempo de execução — variáveis desconhecidas permanecem inalteradas, um mero `$`nunca é especial, e uma variável sem valores de contexto é renderizado como uma string vazia. `${base_prompt}` incorpora o prompt de sistema padrão efetivo (o padrão embutido, ou seu `SYSTEM.md`substitui quando presente), então, um arquivo pode encobrir o comportamento padrão em vez de substituí-lo. Se o arquivo substitui o `${plugin_sections}` onde essas instruções deveriam aparecer. As variáveis disponíveis estão listadas na seção SYSTEM.md abaico.

Campos desconhecidos são ignorados, então, novos arquivos permaneçam legíveis à versões antigas. Campos de outras ferramentas de agentes (como o `model` do Claude Code ou o `mode` do OpenCode) são ignorados da mesma forma, o formato `tools` com itens separados por vírgula permite carregar arquivos de agente no estilo do Claude Code, e um `name` faltando recorre ao nome do arquivo para que arquivos no estilo OpenCode também sejam carregados — um arquivo mínimo com `description` e um corpo funciona em várias ferramentas.

Um arquivo com conteúdo inválido encontrado em um diretório é ignorado, com a emissão de um aviso, e não afeta outros arquivos. Um arquivo passado explicitamente via `--agent-file` deve ser válido — caso contrário, a CLI relata o erro e é encerrada.

::: Nota de aviso
Os parâmetros `tools` e `disallowedTools` definem as ferramentas apresentadas ao modelo e são validados novamente antes da execução. O parâmetro `subagents` funciona da mesma forma: a ferramenta `Agent` lista apenas os tipos de subagentes para os quais o chamador pode delegar tarefas, e tanto `Agent` quanto `AgentSwarm` verificam novamente a lista de permissões antes de realizar o despacho; a retomada de um subagente existente é uma exceção a essa regra. As regras de permissão permanecem como um controle separado para operações que exigem aprovação.
:::

Agentes personalizados delegados como subagentes são executados sem a estrutura padrão de subagente (na qual "sua mensagem final é a transferência completa"). Se você criar um agente destinado à delegação, especifique no corpo da instrução que a última mensagem dele deve ser o resultado completo e autossuficiente para quem o acionou.

### Selecionando o Agente Principal

Duas flags CLI selecionam qual agente inicia um nova sessão, tanto em modo de impressão (`kimi -p`) quanto na TUI interativa:

- **`--agent <name>`**: Inicia a sessão com o agente especificado como o Agente principal. O nome pode se referir a um agente embutido ou a qualquer arquivo conhecido; um nome desconhecido resulta em erro, listando os agentes disponíveis.
- **`--agent-file <path>`**: Carrega um arquivo de agente com a prioridade mais alta para esta inicialização e começa com ele. A flag aceita exatamente um arquivo: ele não pode ser repetido e não pode ser combinado com `--agent`.

Ambas as flags se aplicam apenas quando começando uma nova sessão — nenhuma pode ser combinada com `--session`/`--continue`. O agente é vinculado no momento da criação da sessão, e a retomada restaura automaticamente o agente vinculado, então, não é necessário (nem permitido) usar uma flag ao retomar a execução.

Por exemplo:

```sh
kimi --agent reviewer
kimi -p --agent reviewer "Revise as alterações nesta branch"
```

O agente vinculado é a identidade da sessão: ele é fixado na primeira vinculação da sessão e não pode ser trocado depois. Na TUI, as flags aplicam-se apenas à sessão de inicialização; uma sessão criada depois no mesmo processo (por exemplo, via `/new`) começa com o agente padrão.

Para a personalização do agente principal, referencie `${base_prompt}` no corpo para que as injeções de ambiente, instrução de workspace, Skill e plugin, já presentes no prompt padrão efetivo, permaneçam em vigor. Quando quiser trocar o prompt padrão mas manter apenas as instruções fornecidas por plugins, use `${plugin_sections}` mo lugar. Um corpo sem `${base_prompt}` ou `${plugin_sections}` é proprietário de todo o prompt e exclui instruções de plugin, o que é adequado para subagentes autônomos.

### Substituindo o prompt de sistema do agente principal pelo SYSTEM.md

Para permanentemente substituir o sistema de prompt do agente principal — sem passar `--agent` ou `--agent-file` em todas as inicializações — escreva um arquivo `$KIMI_CODE_HOME/SYSTEM.md` (padrão: `~/.kimi-code/SYSTEM.md`; ele move com `KIMI_CODE_HOME`). Equanto o arquivo existir e não estiver vazio, ele substitui completamente o sistema de prompt padrão do agente principal embutido — e apenas o prompt: a descrição, conjunto de ferramentas, e a lista de permissões de delegação do subagente são herdadas dos padrões embutidos. SYSTEM.md entra em vigor em todos os modos de inicialização, incluindo sessões TUI interativas.

SYSTEM.md é um corpo em Markdown simples — frontmatter não é requerido ou lido. Um arquivo ausente ou vazio não tem efeito, e uma falha de leitura faz o sistema retornar ao prompt integrado, exibindo um aviso. A intenção explícita ainda prevalece sobre isso: um arquivo de agente de mesmo nome no escopo do projeto que declare `override: true`, bem como qualquer arquivo passado via `--agent-file`, têm precedência; além disso, selecionar outro agente com `--agent` ignora completamente essa configuração. Dentro do próprio escopo do usuário, o arquivo `SYSTEM.md` prevalece sobre um arquivo de mesmo nome encontrado nos diretórios `agents/`.

Como o corpo de um arquivo de agente comum, SYSTEM.md é renderizado como um modelo cada vez que o prompt é criado — Os espaços reservados `${var}` no corpo são substituídos a partir do contexto em tempo de execução:

| Variável | Conteúdo |
| --- | --- |
| `${skills}` | A injeção de habilidades do agente mescladas; vazia quando a ferramenta `Skill` não está disponível. |
| `${agents_md}` | Conteúdo dos arquivos de instrução do workspace (como `AGENTS.md`) |
| `${cwd}` | Current working directory |
| `${cwd_listing}` | Listagem do diretório de trabalho |
| `${os}` |Tipo de sistema operacional |
| `${shell}` | Nome e caminho do shell, por exemplo `bash (\`/bin/bash\`)` |
| `${additional_dirs_info}` | Diretórios adicionais incluídos no espaço de trabalho; vazio quando não houver nenhum. |
| `${base_prompt}` | O prompt de sistema padrão. No próprio `SYSTEM.md`, este é o padrão nativo; em um arquivo de agente, é o padrão efetivo — o padrão embutido ou a sua substituição via `SYSTEM.md`, quando presente |
| `${plugin_sections}` | Um bloco completo de instruções de plugins fornecido pelos plugins habilitados; fica vazio quando nenhum plugin habilitado fornece instruções. |

Variáveis ​​desconhecidas permanecem inalteradas, um símbolo `$` isolado não tem função especial e uma variável sem valor definido no contexto é renderizada como uma string vazia. Quatro blocos pré-definidos — `${windows_notes}`, `${additional_dirs_section}`, `${skills_section}` e `${plugin_sections}` — renderizam a seção correspondente do prompt padrão integrado ou uma string vazia quando não se aplicam. O prompt padrão integrado já inclui `${plugin_sections}`, portanto, não o adicione novamente caso `${base_prompt}` já se expanda para esse prompt. As variáveis ​​são suficientes para reconstruir a estrutura básica do prompt integrado; por exemplo:

```markdown
Você é a Kimi, em execução em ${cwd} no ${os}.

${agents_md}

${skills}

${plugin_sections}
```

## Arquivos de Instruções

Instruções globais específicas do Kimi podem ficar em `$KIMI_CODE_HOME/AGENTS.md` (padrão: `~/.kimi-code/AGENTS.md`). Ao alterar o diretório raiz dos dados usando `KIMI_CODE_HOME`, esse arquivo de instruções globais é movido junto. Instruções genéricas compartilhadas entre ferramentas ainda podem residir em `~/.agents/AGENTS.md` no diretório *home* real do sistema operacional, e instruções em nível de projeto permanecem na árvore do projeto — por exemplo, em `.kimi-code/AGENTS.md` ou `AGENTS.md`.

## Localização de Armazenamento no Duretório de Sessão

O estado de execução do subagente é persistido no subdiretório `agents/` do diretório da sessão atual. Cada instância de subagente possui seu próprio diretório, contendo um arquivo `wire.jsonl` que registra prompts, histórico de mensagens e o estado final em ordem cronológica. Subagentes em segundo plano também expõem o status de seu ciclo de vida por meio de um subdiretório `tasks/`.

::: Nota de aviso
Diretórios de sessão, arquivos *wire* e registros de tarefas são materiais de depuração locais que podem conter prompts do usuário, saídas de comandos, caminhos de repositório, valores de retorno de ferramentas ou vestígios de credenciais. Não envie esses arquivos diretamente para repositórios públicos, *issues* ou registros de chat; oculte informações confidenciais antes de compartilhá-los.
:::

## Próximos passos

- [Hooks](./hooks.md) — Acionam notificações ou intercepções via script local em momentos-chave, como a conclusão de um subagente
- [Habilidades do Agente](./skills.md) — Incorporam conhecimento especializado e fluxos de trabalho aos subagentes