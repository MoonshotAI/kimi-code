# Substituições de configuração

O Kimi Code CLI tem três lugares em que os parâmetros de execução podem ser influenciados: o arquivo de configuração, as opções de linha de comando e as variáveis de ambiente. Eles não formam uma simples pilha de prioridades: os três atendem a cenários diferentes e têm escopos que não se sobrepõem:

- **Arquivo de configuração** armazena preferências de longo prazo (modelo, chaves, controle de loop etc.); tem efeito em toda inicialização
- **Opções de linha de comando** fazem alterações pontuais para a inicialização atual; são descartadas ao sair
- **Variáveis de ambiente** tratam principalmente da localização do diretório de dados, da troca de endpoints OAuth e de um pequeno número de chaves de execução. Elas **não são um mecanismo geral de fallback para os campos de configuração**.

Essa distinção importa: muitos usuários executam `export KIMI_API_KEY=xxx` no shell esperando que o CLI a utilize automaticamente, mas isso não acontece. Veja [Credenciais do provedor](#credenciais-do-provedor) abaixo para entender o motivo.

## Três papéis das variáveis de ambiente

As variáveis de ambiente se dividem em três categorias, conforme a função, e não podem ser reduzidas a uma única ordem linear de prioridade:

1. **Localizar o arquivo de configuração**: `KIMI_CODE_HOME` define o diretório raiz de dados, fazendo com que o caminho do arquivo de configuração seja `$KIMI_CODE_HOME/config.toml`. Essa etapa ocorre antes de toda a outra resolução e não é um fallback para parâmetros individuais.
2. **Chaves de execução**: um pequeno conjunto de variáveis, como `KIMI_DISABLE_TELEMETRY`, desliga diretamente o subsistema correspondente. Mesmo que o `config.toml` tenha `telemetry = true`, um valor verdadeiro (truthy) nessa variável desativa a telemetria. A semântica é "desativar adicionalmente", e não "substituição comum".
3. **Endpoints de execução e diagnóstico**: variáveis como `KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_BASE_URL` e `KIMI_LOG_LEVEL` são lidas quando os subsistemas de OAuth ou de logs são inicializados. Para a lista completa, consulte [Variáveis de ambiente](./env-vars.md).

## Prioridade dos parâmetros de execução comuns

Para parâmetros de execução comuns, como alias de modelo, modo Plan, modo de permissão e diretórios de Skills, a prioridade, da mais alta para a mais baixa, é:

1. **Opções de linha de comando** (`-m`, `--plan`, `--yolo` etc.): valem somente para a inicialização atual
2. **Arquivo de configuração do usuário** (`~/.kimi-code/config.toml`): armazena preferências de longo prazo

Um pequeno número de variáveis de ambiente substitui explicitamente campos específicos do arquivo de configuração. Por exemplo, `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` tem prioridade maior que `[background].keep_alive_on_exit`. Essas exceções estão indicadas em [Variáveis de ambiente](./env-vars.md) e nas descrições dos campos correspondentes em [Arquivos de configuração](./config-files.md).

::: warning
**Os parâmetros de execução comuns não recorrem às variáveis de ambiente do shell.** O `api_key` / `base_url` do provedor são lidos somente do `config.toml` (incluindo a subtabela `[providers.<name>.env]`) e não recorrem a variáveis do shell definidas com `export`. As únicas exceções são a família `KIMI_MODEL_*` e o campo `api_key_env` do provedor, dois canais explícitos que *de fato* leem credenciais do shell; consulte [Definir um modelo a partir de variáveis de ambiente](./env-vars.md#define-a-model-from-environment-variables-kimi_model_) e [Credenciais do provedor](#credenciais-do-provedor).
:::

Atualmente, o CLI lê um único arquivo de configuração de nível de usuário e não possui mecanismo de arquivo de configuração por projeto. Para isolar a configuração entre projetos diferentes, aponte `KIMI_CODE_HOME` para diretórios de dados diferentes; veja [Cenários comuns](#cenarios-comuns) abaixo.

## Credenciais do provedor

As credenciais do provedor (`api_key`, `base_url`) seguem regras de resolução próprias, separadas da cadeia de prioridade dos parâmetros comuns.

Para um único provedor, as credenciais são resolvidas nesta ordem:

1. `[providers.<name>].api_key`: chave escrita diretamente no arquivo de configuração
2. `[providers.<name>].api_key_env`: nome de uma variável de ambiente do shell da qual a chave será lida
3. A chave correspondente dentro da subtabela `[providers.<name>.env]` (`KIMI_API_KEY`, `ANTHROPIC_API_KEY` etc.): consultada somente quando nenhum dos campos acima está presente
4. Se todas estiverem ausentes, a inicialização falha com um erro informando que o provedor não tem credenciais

`api_key` e `api_key_env` são alternativas, não uma cadeia de prioridade: defina exatamente uma — definir as duas é rejeitado como conflito de configuração, assim como definir `api_key_env` junto com `oauth`.

`api_key_env` é a única exceção deliberada à regra de "nenhuma variável de ambiente do shell para credenciais": o valor é relido do ambiente do próprio processo a cada requisição, portanto nunca é mantido em cache além da vida útil do processo e nenhum segredo fica gravado no `config.toml`. Observe que um processo em execução enxerga apenas o ambiente com o qual foi iniciado — para rotacionar a variável é preciso reiniciar o processo do `kimi` / TUI ou do kap-server; um novo `export` no shell pai afeta apenas processos recém-criados. Declarar `api_key_env` enquanto a variável não estiver definida ou estiver vazia falha imediatamente com um erro que indica o provedor e a variável — nas verificações de prontidão da sessão (modo print, criação de sessão do kap-server) e no momento da requisição — e nunca é ignorado silenciosamente, sem fallback para outra fonte de credencial.

`base_url` é resolvido da mesma forma: primeiro `[providers.<name>].base_url`, depois a chave `*_BASE_URL` em `[providers.<name>.env]`.

> A subtabela `[providers.<name>.env]` é apenas uma seção TOML no arquivo de configuração e não grava nada no ambiente do shell. Ela só é consultada quando o campo direto correspondente (`api_key` / `base_url`) está vazio.

Para a lista completa dos nomes das chaves de credencial, consulte [Variáveis de ambiente: nomes das chaves de credencial do provedor](./env-vars.md#provider-credential-key-names-written-in-configtoml).

## Opções de linha de comando

As opções passadas na inicialização têm a prioridade mais alta e valem apenas para a sessão atual:

| Opção | Efeito |
| --- | --- |
| `-S, --session [id]` | Retoma uma sessão específica; entra em seleção interativa quando nenhum id é informado |
| `-c, --continue` | Retoma a última sessão do diretório de trabalho atual |
| `-y, --yolo` | Modo Ask When Needed: edições e comandos de rotina são executados automaticamente; o agente ainda pode fazer perguntas |
| `--auto` | Modo Never Ask: nunca interrompe você; o agente não fará perguntas |
| `--plan` | Inicia no modo Plan |
| `-m, --model <model>` | Usa um alias de modelo específico nesta sessão |
| `-p, --prompt <prompt>` | Executa em modo não interativo: executa um único prompt e sai |
| `--output-format <format>` | Formato de saída do modo `-p`: `text` ou `stream-json` |
| `--skills-dir <dir>` | Substitui os diretórios de Skills descobertos automaticamente (repetível; vale apenas para esta sessão) |

Regras de exclusão mútua (a inicialização falha se forem violadas):

- `--output-format` só pode ser usado com `-p`
- `--prompt` não pode ser combinado com `--yolo` nem com `--plan`
- `--continue` e `--session` não podem ser usados juntos
- Fora do modo prompt, `--yolo` e `--plan` não podem ser combinados com `--continue` nem com `--session`

::: tip
`--skills-dir` é uma substituição pontual que afeta apenas a inicialização atual. Para adicionar diretórios de busca de forma persistente, escreva `extra_skill_dirs` no `config.toml` (consulte [Agent Skills](../customization/skills.md)).
:::

## Cenários comuns

**Ambiente de teste isolado**: use um diretório de dados separado para evitar poluir a configuração e as sessões principais:

```sh
KIMI_CODE_HOME="$PWD/.kimi-sandbox" kimi
```

**Chave de teste pontual**: como as credenciais do provedor são lidas somente do arquivo de configuração, grave uma chave de teste na subtabela `env`:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-test"
```

**Pular a aprovação em tarefas em lote**:

```sh
kimi --yolo -p "Renomeie em lote os seguintes arquivos..."
```

**Entrar temporariamente no modo Plan** (para torná-lo permanente, defina `default_plan_mode = true` no arquivo de configuração):

```sh
kimi --plan
```

## Próximos passos

- [Arquivos de configuração](./config-files.md) — referência completa de todos os campos configuráveis
- [Variáveis de ambiente](./env-vars.md) — lista completa e descrição de `KIMI_CODE_HOME` e de variáveis relacionadas