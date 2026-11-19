# Skills de Agente

As Skills de Agente são um mecanismo leve para ampliar as capacidades do modelo no Kimi Code CLI. Uma Skill é um documento Markdown com um frontmatter YAML que descreve uma área de conhecimento especializada ou um fluxo de trabalho: diretrizes de estilo de código de um projeto, um processo de revisão de PR ou um formato de mensagem de commit.

Em comparação com colar as mesmas instruções em um prompt a cada vez, as Skills oferecem a vantagem de manter o conteúdo em um arquivo, permitindo a reutilização entre projetos e equipes, o carregamento instantâneo via slash command e a invocação automática pelo modelo quando necessário.

## Criando uma Skill

Os arquivos da  devem ser colocados em um [diretório de varredura conhecido](#skill-locations). Há suporte para dois formatos de estrutura de arquivos:

- **Formato de diretório (recomendado)**: Crie um subdiretório dentro do diretório de skills com o arquivo principal chamado `SKILL.md` e coloque scripts, material de referência e outros arquivos de suporte junto a ele.

- **Formato simples (flat)**: Ignore o subdiretório e coloque um único arquivo `.md` diretamente no diretório de skills — ideal para Skills simples que não requerem arquivos de suporte.

Ambas as estruturas registram uma Skill; a diferença reside apenas na forma como os arquivos são organizados:

```text
skills/
├── review-pr/              # Formato de diretório → Nome da skill: review-pr
│   ├── SKILL.md            # Arquivo principal
│   └── checklist.md        # Arquivo de suporte, referenciado via ${KIMI_SKILL_DIR}
└── commit.md               # Formato de arquivo único → Nome da skill: commit
```

Como o nome da Skill é definido:

- Formato de diretório: a partir do campo obrigatório `name` no cabeçalho (veja a tabela abaixo); por convenção, o subdiretório tem o mesmo nome — `review-pr/SKILL.md` com `name: review-pr` é registrado como `review-pr`.
- Formato flat: o campo `name` pode ser omitido, utilizando-se o nome do arquivo sem a extensão `.md` — `commit.md` é registrado como `commit`. A extensão é removida apenas do nome registrado da Skill; o arquivo no disco deve manter a extensão `.md` para ser detectado pelo scanner, portanto, não crie um arquivo chamado `commit` sem extensão.
- Quando tanto `<name>/SKILL.md` quanto `<name>.md` existem no mesmo diretório, o formato de diretório prevalece e o arquivo simples é ignorado.

Duas limitações do formato plano:

- Apenas arquivos `.md` localizados diretamente no nível raiz de um diretório de skills são reconhecidos; arquivos `.md` soltos dentro de subdiretórios (exceto `SKILL.md`) não são tratados como Skills.
- Uma flat Skill não possui diretório próprio, portanto `${KIMI_SKILL_DIR}` aponta para o próprio diretório de skill — utilize o formato de diretório sempre que a skill precisar de arquivos de suporte.

### Formato do Arquivo

O arquivo `SKILL.md` consiste em duas partes: um frontmatter YAML e um corpo em Markdown:

```markdown
---
name: code-style
description: Diretrizes de estilo de código do projeto que definem nomenclatura, indentação, comentários e organização de arquivos
type: prompt
whenToUse: Quando o usuário me pede para escrever, modificar ou revisar o código-fonte do projeto
disableModelInvocation: false
arguments:
  - target
  - mode
---

Por favor, siga estas diretrizes ao lidar com o código:

- Use indentação de 2 espaços
- Nomes de variáveis ​​devem usar `camelCase`; nomes de tipos usam `PascalCase`
- Funções públicas devem ter comentários TSDoc
- As linhas não devem exceder 100 caracteres
```

### Campos do Frontmatter

| Campo | Descrição |
| --- | --- |
| `name` | Nome da Skill (não diferencia maiúsculas de minúsculas). Obrigatório no formato de diretório `SKILL.md`; no formato de arquivo único `.md`, utiliza-se o nome do arquivo sem a extensão `.md` |
| `description` | Resumo de uma linha que o modelo utiliza para decidir quando invocar a Skill. Obrigatório no formato de diretório `SKILL.md`; no formato de arquivo único `.md`, utiliza-se a primeira linha não vazia do corpo (até 240 caracteres) |
| `type` | Tipo de Skill: `prompt` (padrão), `inline` (o mesmo que `prompt`), `flow` (apenas invocação manual). Outros valores são ignorados |
| `whenToUse` | Descrição de quando a Skill deve ser acionada. Também aceita `when-to-use` e ​​`when_to_use` |
| `disableModelInvocation` | Se definido como `true`, bloqueia a invocação automática pelo modelo. Também aceita `disable-model-invocation`, `disable_model_invocation` |
| `arguments` | Parâmetros nomeados; um array de strings ou uma string com itens separados por espaços (ex.: `arguments: target mode`). Uma vez declarados, podem ser lidos no corpo como `$<nome>` |

::: Nota de aviso
No formato de diretório `SKILL.md`, tanto `name` quanto `description` **devem** ser fornecidos explicitamente. A omissão de qualquer um deles causará falha no processamento.
:::

### Placeholders do Corpo

Antes de o corpo ser enviado ao modelo, um pequeno conjunto de placeholders é expandido:

- `$ARGUMENTS`: A string completa e bruta de argumentos passada na invocação
- `$ARGUMENTS[0]`, `$ARGUMENTS[1]` e as formas abreviadas `$0`, `$1`: Argumentos posicionais após a separação por espaços em branco (indexação baseada em zero)
- `$<nome>`: Parâmetros nomeados declarados em `arguments`
- `${KIMI_SKIMI_DIR}`: O diretório que contém o arquivo da Skill atual

Argumentos posicionais suportam o uso de aspas simples e duplas; assim, em `/skill:commit "fix login" patch`, `$0` é expandido para `fix login`. Se o corpo não contiver placeholders de argumentos, o texto passado na invocação será anexado ao final do corpo no formato `\n\nARGUMENTS: <texto>`.

## Locais das Skills

A CLI do Kimi Code verifica quatro níveis de escopo; escopos mais específicos têm maior prioridade: **Projeto > Usuário > Extra > Integrada (Built-in)**

**Nível de usuário** (aplica-se a todos os projetos):
- `$KIMI_CODE_HOME/skills/` (padrão: `~/.kimi-code/skills/`)
- `~/.agents/skills/`

O diretório de Skills do usuário específico do Kimi acompanha a variável `KIMI_CODE_HOME`; portanto, raízes de dados isoladas também possuem Skills específicas do Kimi isoladas. O diretório genérico `~/.agents/skills/` permanece no diretório home real do sistema operacional, permitindo que seja compartilhado entre diferentes ferramentas.

**Nível de projeto** (raiz do projeto = o diretório mais próximo que contenha `.git`, pesquisando a partir do diretório de trabalho em direção à raiz do sistema de arquivos):
- `.kimi-code/skills/`
- `.agents/skills/`

**Diretórios extras**: Declarados por meio de `extra_skill_dirs` no nível superior do arquivo `config.toml`:

```toml
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
```

As **Skills Integradas** são distribuídas com a CLI e possuem a prioridade mais baixa. Elas oferecem fluxos de trabalho prontos para uso em tarefas comuns: configuração de servidores MCP, personalização do tema da TUI e edição de arquivos de configuração. Consulte [comandos de Skills integradas](../reference/slash-commands.md#built-in-skill-commands) para ver a lista completa. Aquelas relacionadas ao próprio Kimi Code podem ser desativadas usando o campo de nível superior [`builtin_product_skills`](../configuration/config-files.md#top-level-fields).

## Invocando uma Skill

Os usuários podem invocar uma Skill manualmente usando um slash command:

```
/skill:code-style
/skill:git-commits fix concurrency issue in login endpoint
```

O modelo também pode invocar uma Skill automaticamente com base em `description` e `whenToUse` (a menos que `disableModelInvocation` seja `true` ou `type` seja `flow`). As invocações de Skill permitem até 3 níveis de aninhamento; além disso, elas são encerradas.

## Exemplo Completo

```markdown
---
name: review-pr
description: Analisar um Pull Request de acordo com os padrões da equipe e gerar um relatório de revisão estruturado
type: prompt
whenToUse: Quando o usuário pedir para analisar um PR, inspecionar alterações de código ou avaliar a qualidade dos commits
arguments:
  - pr_ref
---

Por favor, analise o PR especificado pelo usuário: $pr_ref

1. Obtenha e leia o diff completo de `$pr_ref`.
2. Verifique cada um dos seguintes itens:
   - Se os casos de teste correspondentes foram incluídos
   - Se a documentação da API pública foi atualizada
   - Se novas dependências foram introduzidas; em caso afirmativo, indique o motivo
   - Se o tratamento de erros cobre edge cases
3. Consulte a checklist no mesmo diretório: `references/checklist.md`
4. Gere um relatório de revisão contendo:
   - Conclusão geral (aprovar / solicitar alterações / comentar)
   - Alterações necessárias (bloqueantes)
   - Melhorias sugeridas (não bloqueantes)
   - Pontos positivos relevantes
```

Salve isso como `$KIMI_CODE_HOME/skills/review-pr/SKILL.md` (ou `~/.kimi-code/skills/review-pr/SKILL.md` quando `KIMI_CODE_HOME` não estiver definido), coloque a checklist em `references/checklist.md` no mesmo diretório e, após iniciar uma nova sessão, você poderá invocá-la com `/skill:review-pr #1234`, onde `#1234` é expandido para `$pr_ref`. ## Próximos passos

- [Plugins](./plugins.md) — Empacote Skills em unidades instaláveis ​​para compartilhar com sua equipe
- [Agentes e subagentes](./agents.md) — Como as Skills influenciam o comportamento de subagentes