# Arquivos de configuração

O Kimi Code CLI salva todas as preferências de longo prazo em arquivos TOML (configuração em texto simples) dentro do diretório `~/.kimi-code/`: as configurações de tempo de execução (*runtime*) ficam em `config.toml`, e as preferências da interface de terminal (TUI) ficam em um arquivo parceiro `tui.toml`.

## Localização do arquivo de configuração

O CLI lê a configuração a partir de `~/.kimi-code/config.toml`, criado automaticamente na primeira execução. Para redefinir o diretório de dados, sobrescreva-o com a variável de ambiente `KIMI_CODE_HOME`:

```sh
export KIMI_CODE_HOME=/caminho/para/kimi-home
```

O caminho do arquivo de configuração passa a ser `$KIMI_CODE_HOME/config.toml`. Independentemente de onde o diretório esteja localizado, o nome do arquivo sempre será `config.toml`.

::: tip Dica
Os nomes dos campos no TOML sempre usam `snake_case`, por exemplo, `default_model` e `max_context_size`. Se uma chave contiver `.`, você deve colocá-la entre aspas (por exemplo `[models."gpt-4.1"]`); caso contrário, o TOML tratará o `.` como um separador de tabela aninhada.
:::

## Exemplo completo

O exemplo a seguir cobre os campos de configuração mais comumente usados. Você pode copiá-lo e ajustá-lo conforme necessário:

```toml
default_model = "kimi-code/k3"
default_permission_mode = "manual"
default_plan_mode = false
merge_all_available_skills = true
telemetry = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "max"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[thinking]
enabled = true
effort = "high"
keep = "all"

[loop_control]
max_attempts_per_step = 10
reserved_context_size = 50000

[task]
max_running_tasks = 4
keep_alive_on_exit = false

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = ""

[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/check-bash.mjs"
timeout = 5
```

## Campos de nível superior (*top-level*)

Os campos no arquivo de configuração se dividem em duas categorias: **escalares de nível superior** que controlam diretamente o comportamento padrão, e **tabelas aninhadas** (`providers`, `models`, `thinking`, etc.) que possuem sua própria estrutura, descrita individualmente nas seções abaixo.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `default_model` | `string` | — | Alias do modelo padrão; deve estar definido em `models` |
| `default_permission_mode` | `string` | `manual` | Modo de permissão padrão para novas sessões: `manual`, `yolo` ou `auto`. Veja [os três modos de permissão](../guides/interaction.md#the-three-permission-modes) |
| `default_plan_mode` | `boolean` | `false` | Define se as novas sessões iniciam no [modo de Planejamento (Plan mode)](../guides/interaction.md#plan-mode) por padrão. Não se aplica no modo não interativo (`kimi -p`) |
| `merge_all_available_skills` | `boolean` | `true` | Define se deve mesclar Agent Skills de todos os diretórios disponíveis |
| `extra_skill_dirs` | `array<string>` | — | Diretórios adicionais de busca de skills, aplicados em camada sobre os diretórios padrão |
| `extra_agent_dirs` | `array<string>` | — | Diretórios adicionais de busca de agentes personalizados, aplicados em camada sobre os diretórios padrão |
| `builtin_product_skills` | `boolean` | `true` | Define se as skills embutidas que documentam o próprio Kimi Code são oferecidas ao modelo |
| `telemetry` | `boolean` | `true` | Define se a telemetria anônima está ativada; desativada apenas quando definida explicitamente como `false` |
| `auto_session_title` | `boolean` | `true` | Define se os clientes podem gerar títulos de sessão automaticamente; desativada apenas quando definida explicitamente como `false` |
| `disable_feedback_survey` | `boolean` | `false` | Desativa a solicitação ocasional de avaliação de sessão no CLI e no aplicativo desktop |
| [`providers`](#providers) | `table` | `{}` | Tabela de provedores de API |
| [`models`](#models) | `table` | — | Tabela de aliases de modelos |
| [`thinking`](#thinking) | `table` | — | Parâmetros padrão para o modo de Pensamento (*Thinking mode*) |
| [`loop_control`](#loop_control) | `table` | — | Parâmetros de controle de loop do agente |
| [`task`](#task) | `table` | — | Parâmetros de tempo de execução para tarefas em segundo plano e agente Tower; `background` é o nome herdado (*legacy*) da seção |
| [`tools`](#tools) | `table` | — | Chave de alternância global de ferramentas (*tools*) |
| [`image`](#image) | `table` | — | Parâmetros de compressão de imagem |
| [`workspace`](#workspace-trust) | `table` | — | Configurações do espaço de trabalho, incluindo a validação de confiança (*trust gate*) |
| [`services`](#services) | `table` | — | Configuração de serviços externos integrados |
| [`permission`](#permission) | `table` | — | Regras de permissão iniciais |
| [`environments`](#environments) | `table` | — | Declarações de ambientes remotos |
| [`hooks`](../customization/hooks.md) | `array<table>` | — | Hooks de ciclo de vida |
| [`identity`](#identity) | `table` | — | Identidade personalizada do agente |

## `providers`

Cada entrada na tabela `providers` define um provedor de API, identificado por um nome exclusivo. O CLI lê as credenciais apenas a partir daqui. Ele **não** busca variáveis de ambiente do shell automaticamente por padrão: executar `export KIMI_API_KEY` no terminal não atribui a chave a nenhum provedor; você deve escrevê-la explicitamente no arquivo de configuração ou apontar `api_key_env` para o nome de uma variável (veja [Substituições de configuração](./overrides.md#provider-credentials)).

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `type` | `string` | Sim | Tipo de provedor: `kimi`, `anthropic`, `openai`, `openai_responses`, `google-genai`, `vertexai` |
| `api_key` | `string` | Não | Chave de API, escrita em texto simples no arquivo de configuração |
| `api_key_env` | `string` | Não | Nome da variável de ambiente do shell a partir da qual a chave de API será lida em vez de ser armazenada no arquivo de configuração; relida a cada requisição. Mutuamente exclusivo com `api_key` e `oauth`; uma variável não definida ou vazia falha a requisição com um erro indicando o nome da variável |
| `base_url` | `string` | Não | URL base da API |
| `oauth` | `table` | Não | Referência de credencial OAuth (campos `storage` e `key`); injetado automaticamente pelo fluxo de login, de modo que você normalmente nunca precisa escrever isso manualmente |
| `env` | `table<string, string>` | Não | Fonte alternativa de recurso para credenciais do provedor; veja a subtabela `env` |
| `custom_headers` | `table<string, string>` | Não | Cabeçalhos HTTP personalizados anexados a cada requisição |

**Subtabela `env`**: Você pode escrever nomes de chaves convencionais de provedores (como `KIMI_API_KEY`) dentro de `[providers.<name>.env]` como uma fonte alternativa para `api_key` / `base_url`. Esta subtabela é **lida exclusivamente a partir do arquivo de configuração** e não modifica o ambiente do shell:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

Prioridade: `api_key` ou `api_key_env` (alternativas mutuamente exclusivas — defina exatamente uma) > chave da subtabela `env` (apenas quando nenhuma das anteriores estiver presente) > se todas estiverem ausentes, a inicialização falha com erro. Durante a atualização de `/models`, um provedor cuja variável declarada estiver indefinida ou vazia será relatado como com falha sem afetar outros provedores.

## `models`

Cada entrada na tabela `models` define um alias de modelo (o nome usado em `default_model` ou na flag `-m`), identificado por um nome exclusivo.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `provider` | `string` | Sim | Nome do provedor a ser usado; deve estar definido em `providers` |
| `model` | `string` | Sim | Identificador do modelo enviado ao servidor ao chamar a API |
| `max_context_size` | `integer` | Sim | Tamanho máximo do contexto em tokens; deve ser no mínimo 1 |
| `max_input_size` | `integer` | Não | Limite de entrada por requisição declarado; compactação, verificações de estouro de contexto e proporções de uso preferem esse valor; o orçamento de conclusão (*completion budgeting*) mantém a janela total |
| `max_output_size` | `integer` | Não | Limite máximo de tokens de saída por requisição (mapeado para `max_tokens`); atualmente apenas o provedor `anthropic` faz a leitura deste valor |
| `capabilities` | `array<string>` | Não | Tags de funcionalidade adicionadas explicitamente: `thinking`, `always_thinking`, `image_in`, `video_in`, `audio_in`, `tool_use`, `dynamically_loaded_tools`; apenas são adicionadas, nunca removidas |
| `support_efforts` | `array<string>` | Não | Níveis de esforço de pensamento (*thinking effort*) aceitos pelo modelo; valores não suportados revertem para `default_effort`, valores fora da lista falham; atualizações gerenciadas podem sobrescrevê-los (fixe via *overrides*) |
| `default_effort` | `string` | Não | Esforço de pensamento padrão para o modelo; atualizações gerenciadas e de plataformas abertas podem sobrescrevê-lo. Fixe via [substituições de modelo](#model-overrides) |
| `off_effort` | `string` | Não | Valor de esforço enviado na comunicação para desativar o pensamento (ex: `none` para o xai grok); a única maneira de realmente interromper o raciocínio em modelos que raciocinam por padrão |
| `upgrade` | `object` | Não | Declaração de atualização de registro personalizado (`model`, `migration_markdown` e `retirement_at` opcional); atualizações gerenciadas a reescrevem |
| `base_url` | `string` | Não | Sobrescrita de endpoint por modelo (escrita por importações de catálogo); tem precedência sobre a `base_url` do provedor, eficaz apenas em conjunto com `protocol` |
| `display_name` | `string` | Não | Nome exibido na interface de usuário (UI); reverte para `model` quando não definido |
| `reasoning_key` | `string` | Não | Exclusivo para o provedor `openai`; definido quando o gateway retorna conteúdo de raciocínio sob um nome de campo não padrão (`reasoning_content` e similares são detectados automaticamente) |
| `adaptive_thinking` | `boolean` | Não | Exclusivo para o provedor `anthropic`; força o pensamento adaptativo como ligado ou desligado, omita para inferir a partir do nome do modelo (Claude ≥ 4.6 usa adaptativo) |

Quando um alias contiver `.`, use uma chave entre aspas:

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576
```

### Substituições de modelo (*Model overrides*)

Use `[models."<alias>".overrides]` para substituições de usuário que devem persistir a atualizações do provedor-modelo. Os consumidores do ambiente leem o valor efetivo: a sobrescrita quando presente; caso contrário, o campo de nível superior.

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"
```

`[models."<alias>".overrides]` aceita campos comuns de modelo, tais como `max_context_size`, `max_input_size`, `max_output_size`, `capabilities`, `display_name`, `reasoning_key`, `adaptive_thinking`, `support_efforts`, `default_effort` e `off_effort`. Não aceita campos de identidade / roteamento (`provider`, `model`, `protocol`, `beta_api` e `base_url`) ou metadados de `upgrade` gerenciados pelo registro.

Você também pode alterar modelos temporariamente sem alterar o arquivo de configuração: definir variáveis de ambiente `KIMI_MODEL_*` sintetiza um provedor temporário em memória que não persiste após a reinicialização. Veja [Definir um modelo a partir de variáveis de ambiente](./env-vars.md#define-a-model-from-environment-variables-kimi_model_).

## `secondary_model`

Subagentes herdam por padrão o modelo no qual o agente principal está sendo executado. A seção `[secondary_model]` torna isso configurável: oferece aos subagentes um conjunto (*pool*) de modelos candidatos além de uma vinculação padrão. Tipicamente, é um modelo mais barato para subtarefas que não exigem a capacidade do modelo principal.

### Pool de modelos de subagentes

O pool está sempre disponível e não requer adesão explícita; sem chaves configuradas em `[secondary_model]`, os subagentes simplesmente herdam o modelo do chamador.

A configuração mínima possui uma linha. Um `default_model` isolado é um pool com uma única entrada:

```toml
[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
```

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `default_model` | `string` | — | O modelo padrão para subagentes |
| `models` | `table<string, string>` | — | Pool de modelos de subagentes; cada chave é o alias de uma entrada configurada em [`[models]`](#models), cada valor é uma dica de seleção |
| `default_effort` | `string` | — | O esforço de pensamento com o qual todo subagente gerado se vincula; se sobrepõe ao `default_effort` da própria entrada do modelo vinculado |

Restrições entre os campos:

- `default_model`: obrigatório quando a tabela `models` estiver configurada, devendo ser uma de suas chaves.
- `models`: os valores podem estar em chinês ou inglês; uma string vazia lista o alias sem nenhuma dica.
- `default_effort` abrange toda a seção: cada execução vincula esse valor independentemente da entrada do pool escolhida. Para esforços por entrada, deixe-o indefinido e use variantes de modelo (veja abaixo).
- `primary` é um alias reservado e não pode ser uma chave do pool.

Os aliases do pool fazem referência à tabela `[models]` atual: se um provedor for posteriormente excluído, desconectado ou se sua lista de modelos atualizada não contiver mais um alias, a inicialização da sessão falhará com um erro de configuração indicando o alias quebrado. Corrija ou remova a entrada para recuperar o sistema. A seção `[secondary_model]` em si nunca é reescrita automaticamente.

Na TUI interativa, o comando [`/secondary-model`](../reference/slash-commands.md) (alias `/subagent-model`) abre um seletor de modelos: a escolha é salva em `default_model` (quando uma tabela de modelos existe e o alias escolhido não está nela, uma entrada com descrição vazia é adicionada), e os subagentes recém-criados utilizam o novo padrão imediatamente, sem necessidade de reiniciar a sessão.

Os subagentes só são executados em modelos listados no pool. Um `default_model` isolado (ou uma tabela `models` com uma única entrada) fixa todos os subagentes naquele modelo. Um pool com duas ou mais entradas ativa a seleção de modelo: as ferramentas `Agent` / `AgentSwarm` ganham um parâmetro `model`, e a descrição da ferramenta lista o pool (com o padrão marcado como `[default]`) para que o agente principal possa escolher por execução. As chaves do pool só podem fazer referência a entradas configuradas em [`[models]`](#models). Os aliases `kimi-code/*` abaixo são provisionados pelo `/login`:

```toml
[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
[secondary_model.models]
"kimi-code/k3" = "Escolha para problemas difíceis. Forte em raciocínio complexo, design de algoritmos, depuração profunda, matemática e desafios sistemáticos."
"kimi-code/kimi-for-coding-highspeed" = "Rápido, porém com custo mais elevado. Bom para tarefas sensíveis à latência: refatoração diária, explicação de código, pequenas edições e resumos."
"kimi-code/kimi-for-coding" = "Um modelo robusto e equilibrado para programação. Bom para a maioria do desenvolvimento de funcionalidades e tarefas de alteração de código."
```

Uma execução resolve o modelo do subagente na seguinte ordem:

1. Um `model` explícito passado na chamada de ferramenta
2. `default_model`

Regras para o parâmetro `model`:

- Aceita apenas aliases do pool. O próprio modelo do agente principal não é uma escolha implícita: para permitir a execução de subtarefas complexas no modelo principal, liste o alias desse modelo no pool explicitamente.
- Quando nem `default_model` nem `models` estiverem configurados, o parâmetro não é exibido e os subagentes herdam o modelo do chamador. Com um pool de entrada única, ele também não é exibido.
- Vincular um alias do pool não herda o esforço de pensamento do chamador, mesmo quando o alias for o próprio modelo do chamador. O `default_effort` da seção prevalece quando definido. Caso contrário, `[thinking].enabled = false` mantém o pensamento desligado; quando ativado, a resolução continua com o `default_effort` da entrada do modelo vinculado, o `[thinking].effort` global e, por fim, o valor intermediário dos `support_efforts` do modelo vinculado.
- Um valor que não seja um alias do pool falha a inicialização com um erro que lista as opções disponíveis.

A chave `force` antiga foi removida: um `default_model` isolado já fixa todos os subagentes a um único modelo. Uma configuração que ainda defina `force` será carregada com um aviso e a chave será ignorada.

### Diferentes esforços de pensamento por entrada do pool

Vincular um alias de pool direciona o subagente para o esforço padrão do modelo vinculado. Você pode aproveitar isso registrando uma entrada "variante" para o mesmo modelo subjacente, para que o agente principal escolha o nível de pensamento junto com o alias:

1. Registre uma segunda entrada para o mesmo modelo subjacente em [`[models]`](#models), sobrescrevendo apenas o `default_effort` via [`[models."<alias>".overrides]`](#model-overrides).
2. Liste o alias original e o alias variante no pool.

```toml
# "kimi-code/k3" é provisionado pelo /login (padrão: high); isto registra
# uma variante com esforço máximo para o mesmo modelo
[models.k3-max]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
support_efforts = [ "low", "high", "max" ]

[models.k3-max.overrides]
default_effort = "max"

[secondary_model]
default_model = "kimi-code/k3"
[secondary_model.models]
"kimi-code/k3" = "Esforço alto padrão. Bom para a maioria das implementações, análises e interações de múltiplos turnos."
k3-max = "O mesmo modelo no esforço máximo de pensamento. Bom para as subtarefas mais difíceis."
```

Dois pré-requisitos:

- O modelo subjacente deve declarar `support_efforts` (sob `managed:kimi-code`, atualmente apenas a família k3 declara níveis de esforço).
- A variante é uma entrada independente e não herda campos da entrada apontada: copie `capabilities`, `support_efforts` e os outros metadados na íntegra, caso contrário `default_effort` não terá efeito (deve ser um elemento de `support_efforts`).

Note a assimetria entre o agente principal e os subagentes vinculados ao pool: para o agente principal, um `[thinking].effort` global configurado sobrescreve o `default_effort` da variante; para subagentes, o `default_effort` da variante prevalece sobre o valor global, e apenas `[secondary_model].default_effort` se sobrepõe a ele. As regras de valor e alternativa seguem a [entrada `default_effort` de `[models]`](#models).

::: warning Atenção
Erros de configuração falham explicitamente em vez de recorrerem a opções padrão em silêncio. A criação, retomada e ramificação (*fork*) da sessão falham na inicialização quando:

- `default_model` estiver ausente, não for uma chave do pool ou se uma chave do pool não for resolvida para uma entrada configurada em [`[models]`](#models).
:::

## `thinking`

`thinking` define o comportamento padrão global para o modo de Pensamento (*Thinking mode*).

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Define se o Pensamento está ativado por padrão para novas sessões; defina como `false` para forçar o desligamento do Pensamento |
| `effort` | `string` | — | Esforço de pensamento: `low` / `medium` / `high` / `xhigh` / `max`; recorre ao padrão do modelo se não estiver em sua lista de suporte |
| `keep` | `string` | `"all"` | Encaminhamento (*passthrough*) do Pensamento preservado: `kimi` envia como `thinking.keep`, `anthropic` como uma edição `clear_thinking_20251015` (roteado para a Messages API beta). Um valor desativado desabilita a função; sobrescrito por `KIMI_MODEL_THINKING_KEEP`; injetado apenas enquanto o Pensamento estiver ativo |

<details><summary>Campos descontinuados</summary>

| Campo | Descontinuado em | Descrição |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | Booleano de nível superior, substituído por `[thinking] enabled`. Migre `default_thinking = true` para `enabled = true` e `default_thinking = false` para `enabled = false`. |
| `thinking.mode` | 0.21.0 | Um dos valores `auto` / `on` / `off`, substituído por `[thinking] enabled`. `mode = "off"` torna-se `enabled = false`; `mode = "on"` e `mode = "auto"` equivalem a `enabled = true` (o padrão) e podem ser removidos. |
| `loop_control.max_retries_per_step` | 0.32.0 | Substituído por `loop_control.max_attempts_per_step` (o valor sempre foi um limite total de tentativas, incluindo a primeira). A chave antiga é ignorada e emite um aviso na inicialização; renomeie-a no `config.toml`. |
| `loop_control.max_steps_per_run` | 0.32.0 | Substituído por `loop_control.max_steps_per_turn`. A chave antiga é ignorada e emite um aviso na inicialização; renomeie-a no `config.toml`. |

</details>

## `loop_control`

`loop_control` rege o limite de etapas, o limite de tentativas por etapa e os limiares com limite de tentativas para a compactação automática de contexto no loop de execução do Agente.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | Máximo de etapas por turno; não definido ou `0` significa ilimitado |
| `max_attempts_per_step` | `integer` | `10` | Máximo de tentativas totais para uma etapa que falhar, incluindo a tentativa inicial |
| `reserved_context_size` | `integer` | — | Número de tokens reservados para a saída do modelo; a compactação automática é acionada quando a janela de contexto restante cai abaixo desse valor |
| `compaction_max_attempts` | `integer` | `5` | Máximo de tentativas totais para uma solicitação de compactação com falha, incluindo a tentativa inicial |

`max_steps_per_turn` pode ser sobrescrito pela variável de ambiente `KIMI_LOOP_MAX_STEPS_PER_TURN`, e `max_attempts_per_step` por `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`; ambas possuem maior prioridade do que o arquivo de configuração. A antiga variável `KIMI_LOOP_MAX_RETRIES_PER_STEP` está descontinuada, mas ainda é aceita (com um aviso na inicialização) quando a nova não estiver definida.

Retentativas aplicam-se apenas a falhas transitórias: erros de conexão, tempos limites (*timeouts*), limites de taxa HTTP 429 e erros de servidor 5xx. Um 429 causado por cota esgotada ou saldo de conta insuficiente não é retentado e falha imediatamente, uma vez que não poderá ter sucesso até que a conta seja recarregada.

## `token_counting`

`token_counting` seleciona qual contagem de tokens de contexto é informada externamente, o valor por trás da exibição do tamanho do contexto. A lógica interna (gatilhos de compactação automática, orçamentos e redução gradual em estouro) sempre utiliza tanto o uso reportado pelo provedor quanto estimativas, independentemente dessa configuração.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `strategy` | `"measured+estimated" \| "measured" \| "estimated"` | `"measured+estimated"` | `measured+estimated` combina o uso medido com uma estimativa da parte restante não medida; `measured` informa apenas o uso do provedor, atualizado quando a requisição é concluída; `estimated` é uma estimativa pura, para provedores que não informam o uso |

`strategy` pode ser sobrescrito pela variável de ambiente `KIMI_TOKEN_COUNTING_STRATEGY`, que possui maior prioridade do que o `config.toml`.

<a id="background"></a>

## `task`

`task` controla o comportamento de concorrência das tarefas em segundo plano (iniciadas via ferramenta `Bash` ou parâmetro `run_in_background=true` da ferramenta `Agent`). A seção herdada `background` aceita os mesmos campos. Quando ambas as seções estiverem presentes, um campo definido em `task` sobrescreve o valor correspondente de `background`; campos omitidos em `task` continuam a usar os valores legados.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | Número máximo de tarefas em segundo plano executadas simultaneamente; também limita workers e revisores do Tower (limite padrão do Tower: 256) |
| `keep_alive_on_exit` | `boolean` | `false` | Define se deve manter as tarefas em segundo plano ainda em execução quando a sessão for encerrada; no modo de impressão (*print mode*), é usado como alternativa quando `print_background_mode` não está definido (`true` = `drain`) |
| `kill_grace_period_ms` | `integer` | `5000` | Período de carência em milissegundos após a solicitação de encerramento de uma tarefa; tarefas ainda em execução são interrompidas à força quando esse tempo expira |
| `bash_auto_background_on_timeout` | `boolean` | `true` | Move um comando `Bash` de primeiro plano para segundo plano quando ocorrer tempo limite, em vez de matá-lo; defina como `false` para encerrar comandos de primeiro plano com tempo limite atingido |
| `bash_task_timeout_s` | `integer` | `600` | Tempo limite padrão (em segundos) para tarefas `Bash` em segundo plano quando a chamada omite `timeout`; `0` significa sem tempo limite. Valores de `timeout` explícitos por chamada não são afetados; o modo de impressão assume o padrão `0` |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"steer"` | Apenas modo de impressão: como as tarefas pendentes em segundo plano são tratadas quando o turno do agente principal termina; `"exit"` encerra imediatamente, `"drain"` aguarda os estados terminais sem enviar resultados de volta, `"steer"` injeta conclusões como mensagens sintéticas de usuário direcionando novos turnos até que não haja pendências |
| `print_wait_ceiling_s` | `integer` | `2147483` | Teto de tempo real (segundos) para o loop de espera/direcionamento do modo de impressão; sem efeito fora do modo de impressão ou com `"exit"` |
| `print_max_turns` | `integer` | `100000` | Número máximo de novos turnos acionados por conclusões de tarefas em segundo plano no modo `"steer"`; mantém o loop de direcionamento limitado |

Para o Tower, `max_running_tasks` limita workers e revisores conjuntamente. Se nenhuma seção de configuração nem `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS` definir um valor, o Tower usará um limite padrão combinado de 256.

`keep_alive_on_exit` pode ser sobrescrito pela variável de ambiente `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT`, `max_running_tasks` por `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS`, `bash_task_timeout_s` por `KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S`, e `print_background_mode`, `print_wait_ceiling_s` e `print_max_turns` por `KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE`, `KIMI_CODE_BACKGROUND_PRINT_WAIT_CEILING_S` e `KIMI_CODE_BACKGROUND_PRINT_MAX_TURNS`; todas possuem prioridade mais alta do que qualquer uma das seções de configuração.

No modo de impressão (`kimi -p "<prompt>"`), o Kimi Code permanece ativo após o turno do agente principal enquanto houver tarefas pendentes em segundo plano: cada conclusão é enviada de volta ao agente principal como uma mensagem sintética de usuário, direcionando-o a um novo turno (`print_background_mode = "steer"` por padrão), e a execução termina assim que um turno é finalizado sem pendências. O loop é limitado por `print_wait_ceiling_s` e `print_max_turns`, ambos efetivamente ilimitados por padrão. O trabalho em segundo plano nunca é encerrado por limite de tempo real no modo de impressão: tarefas `Bash` em segundo plano assumem por padrão a ausência de tempo limite (`bash_task_timeout_s = 0`), e subagentes executam sem tempo limite (`[subagent] timeout_ms` e `[swarm] timeout_ms` são `0` por padrão a menos que configurados), de modo que apenas o próprio modelo encerra uma tarefa. Defina `print_background_mode` para `"drain"` para aguardar as tarefas sem enviar os resultados de volta, ou `"exit"` para encerrar a execução assim que o agente principal terminar.

## `subagent`

`subagent` controla a execução dos subagentes criados pela ferramenta `Agent`.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `timeout_ms` | `integer` | `7200000` (2 horas) | Tempo de execução real máximo (milissegundos) que um único subagente `Agent` pode rodar antes de ser definido como `timed_out`; `0` significa sem tempo limite |

`timeout_ms` pode ser sobrescrito pela variável de ambiente `KIMI_SUBAGENT_TIMEOUT_MS`, que possui maior prioridade do que o `config.toml`.

## `swarm`

`swarm` controla como os subagentes iniciados pela ferramenta `AgentSwarm` são executados, independentemente de `[subagent]`.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `timeout_ms` | `integer` | `7200000` (2 horas) | Tempo de execução real máximo (milissegundos) que um único subagente `AgentSwarm` pode rodar; se o tempo limite for atingido, ele é abortado e o relatório agregado marca `Subagent timed out.`; `0` significa sem tempo limite |

`timeout_ms` pode ser sobrescrito pela variável de ambiente `KIMI_CODE_SWARM_TIMEOUT_MS`, que possui maior prioridade do que o `config.toml`.

## `mcp`

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `startup_timeout_ms` | `integer` | `30000` (30 segundos) | Tempo limite global padrão de conexão (inicialização + descoberta de ferramentas) em milissegundos para todos os servidores MCP; um `startupTimeoutMs` específico por servidor no `mcp.json` prevalece |
| `tool_timeout_ms` | `integer` | `60000` (60 segundos) | Tempo limite global padrão para chamada de uma única ferramenta em milissegundos para todos os servidores MCP; um `toolTimeoutMs` específico no `mcp.json` prevalece |
| `default_deferred` | `boolean` | `false` | Padrão global para [carregar ferramentas sob demanda](../customization/mcp.md#loading-tools-on-demand): quando `true`, as ferramentas de todos os servidores MCP são carregadas sob demanda, a menos que o servidor desative a opção; um campo `deferred` por servidor no `mcp.json` prevalece |
| `reconnect_initial_delay_ms` | `integer` | `5000` (5 segundos) | Atraso inicial em milissegundos antes da primeira tentativa de reconexão automática para um servidor MCP em nível de workspace que falhou ao conectar ou caiu inesperadamente; o atraso dobra após cada tentativa com falha |
| `reconnect_max_delay_ms` | `integer` | `300000` (5 minutos) | Limite máximo em milissegundos para o atraso de reconexão automática de servidores MCP em nível de workspace |

`startup_timeout_ms` e `tool_timeout_ms` podem ser sobrescritos pelas variáveis de ambiente `KIMI_MCP_STARTUP_TIMEOUT_MS` e `KIMI_MCP_TOOL_TIMEOUT_MS`, respectivamente, que possuem maior prioridade do que o `config.toml`. Veja [MCP](../customization/mcp.md) para a configuração completa do servidor MCP.

`reconnect_initial_delay_ms` e `reconnect_max_delay_ms` também podem ser sobrescritos pelas variáveis de ambiente `KIMI_MCP_RECONNECT_INITIAL_DELAY_MS` e `KIMI_MCP_RECONNECT_MAX_DELAY_MS`. A reconexão automática aplica-se apenas a servidores MCP no nível de workspace e é interrompida em falhas permanentes (comando desconhecido, configuração inválida, credenciais estáticas rejeitadas); veja [MCP](../customization/mcp.md).

## `identity`

Personaliza como o agente se identifica. Deixe não configurado e nada mudará.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `name` | `string` | — | Nome de exibição que o agente usa no prompt do sistema (preenche o slot `${product_name}`, inclusive em seus próprios arquivos `SYSTEM.md` e de agente) |
| `slug` | `string` | derivado de `name` | Identificador de máquina em campos de protocolo (token do produto em `User-Agent`, nome do cliente MCP); derivado de `name` quando omitido: convertido para minúsculas, sequências não alfanuméricas convertidas em `-` |

```toml
[identity]
name = "Acme Dev Agent"
slug = "acme-dev"        # opcional
```

Ambos os campos podem ser definidos por meio das variáveis de ambiente `KIMI_CODE_IDENTITY_NAME` e `KIMI_CODE_IDENTITY_SLUG`, que possuem prioridade mais alta do que o `config.toml` e nunca são gravados de volta nele, tornando-os convenientes para contêineres e CI, onde gravar um arquivo de configuração é inconveniente.

Um nome que não contenha letras ou dígitos ASCII (por exemplo, um nome puramente em chinês) não deixa caracteres para derivar um slug e recorre ao padrão `agent`; defina `slug` explicitamente se precisar de um token de protocolo específico.

A identidade é resolvida uma vez na inicialização e permanece válida durante toda a vida do processo: é anunciada aos servidores MCP e provedores quando as conexões são estabelecidas, não podendo mudar no meio do processo. Alterações nesta seção entram em vigor no próximo início, para novas sessões: uma sessão retomada mantém o prompt de sistema com o qual foi gravada, já que suas interações passadas já utilizaram essa identidade. Do mesmo modo, uma autorização MCP OAuth mantém o registro do cliente concedido; redefina a autenticação daquele servidor para registrar sob a nova identidade.

Esta seção é lida pelo motor `agent-core-v2`, que alimenta todas as interfaces do Kimi Code.

## `tools`

`tools` é a chave de alternância global de ferramentas: aplica-se a todos os agentes em todas as sessões e faz interseção com a política individual de `tools` / `disallowedTools` de cada agente.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `enabled` | `array<string>` | — | Lista de permissões (*allowlist*) global: quando não estiver vazia, apenas as ferramentas listadas estarão disponíveis; omitir o campo ou definir uma lista vazia não impõe restrições |
| `disabled` | `array<string>` | — | Lista de bloqueio (*denylist*) global, aplicada após `enabled` |

A correspondência de nomes segue as mesmas regras dos campos de mesmo nome em um arquivo de agente: ferramentas integradas correspondem pelo nome exato (como `Read`), e ferramentas MCP correspondem com padrões curinga (*globs*) (como `mcp__github__*`). Três formatos de entrada nunca correspondem a nada e são informados com um aviso: um caractere curinga fora de um padrão `mcp__` (`enabled = ["*"]` desativa todas as ferramentas, `disabled = ["*"]` não desativa nenhuma), um literal `mcp__` sem o segmento da ferramenta (`mcp__github`; use `mcp__github__*` para todo o servidor) e um nome que nenhuma ferramenta integrada ou registrada possui (a correspondência diferencia maiúsculas de minúsculas).

```toml
[tools]
disabled = ["WebSearch", "FetchURL", "mcp__github__*"]
```

::: warning Atenção
Assim como os campos `tools` / `disallowedTools` de um arquivo de agente, esta seção molda as ferramentas exibidas para o modelo e é aplicada novamente antes da execução. As [Regras de permissão](#permission) permanecem um controle separado para operações que exigem aprovação.
:::

## `read`

`read` controla os limites de caracteres para a [ferramenta `Read`](../reference/tools.md). O limite inclui o conteúdo do arquivo, os números de linha e o bloco de status; ele não impõe um limite separado de contagem de linhas ou de bytes UTF-8.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `default_max_chars` | `integer` | `100000` | Orçamento de caracteres quando a chamada da ferramenta omite `max_chars` |
| `max_chars` | `integer` | `100000` | Orçamento máximo de caracteres que uma chamada de ferramenta pode solicitar |

```toml
[read]
default_max_chars = 100000
max_chars = 100000
```

Ambos os valores devem ser inteiros positivos. O `max_chars` de uma chamada sobrescreve o padrão, mas é limitado ao máximo configurado; o resultado informa o orçamento efetivo. Se o padrão configurado exceder o máximo, o valor máximo também limitará as leituras padrão. Cada chamada também é interrompida em aproximadamente `max_chars` / 4 tokens estimados, contando um token por caractere não-ASCII e por cada quatro caracteres ASCII. Dessa forma, textos com muitos caracteres não-ASCII, como o chinês, retornam menos caracteres por chamada. Aumente `max_chars` para permitir que uma chamada retorne mais de 100.000 caracteres ou cerca de 25.000 tokens, e aumente `default_max_chars` também quando quiser que documentos maiores sejam retornados em uma única chamada sem que o agente precise solicitar um orçamento maior.

## `image`

`image` controla como as imagens são compactadas antes de serem enviadas ao modelo, em todos os pontos de ingestão (imagens coladas, leituras `ReadMediaFile`, imagens nos resultados de ferramentas MCP, etc.).

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `max_edge_px` | `integer` | `2000` | Limite da maior borda em pixels; imagens maiores são reduzidas proporcionalmente. Aumentar este valor preserva mais detalhes ao custo de corpos de requisição maiores |
| `read_byte_budget` | `integer` | `262144` (256 KB) | Orçamento de bytes por imagem para imagens que o modelo lê por conta própria (leituras padrão `ReadMediaFile`); releituras de `region` e `full_resolution` estão isentas |

`max_edge_px` pode ser sobrescrito pela variável de ambiente `KIMI_IMAGE_MAX_EDGE_PX` e `read_byte_budget` por `KIMI_IMAGE_READ_BYTE_BUDGET`; ambas possuem prioridade mais alta do que o `config.toml`.

## `database`

`database` controla os motores de armazenamento incorporados por trás da indexação de sessão e busca global. A indexação de sessão fica ativa por padrão; o índice de busca global em texto completo fica desativado por padrão e, uma vez ativado, analisa sessões passadas em segundo plano e atende a `POST /api/v1/search`.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `base` | `boolean` | `true` | Usa o modelo de leitura baseado em minidb para indexação de sessões; `false` retorna à leitura direta dos metadados da sessão |
| `global_search` | `boolean` | `false` | Constrói o índice global de busca em texto completo e atende a `POST /api/v1/search`; quando desligado, nenhuma sessão é verificada, nenhum worker de busca é iniciado e o endpoint de busca informa o índice como indisponível |
| `search` | `boolean` | `true` | Com a busca global ativada, executa o índice em uma thread de worker dedicada; `false` executa o processo no próprio servidor |

`base` pode ser sobrescrito pela variável de ambiente `KIMI_CODE_PERSISTENCE_MINIDB_READMODEL`, `global_search` por `KIMI_CODE_GLOBAL_SEARCH` e `search` por `KIMI_CODE_SEARCH_WORKER`; todas possuem prioridade mais alta do que o `config.toml`.

## `watch`

`watch` controla os observadores do sistema de arquivos (*filesystem watchers*) que recarregam local.toml, AGENTS.md, skills, configurações MCP e o próprio `config.toml`. O padrão é ativado. Defina `enabled` como `false` para iniciar sem observadores; alterações posteriores no arquivo só serão aplicadas após a reinicialização.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Anexa observadores do sistema de arquivos; `false` desativa todas as chamadas `watch()` para o processo |

`enabled` pode ser sobrescrito pela variável de ambiente `KIMI_CODE_WATCH`, que possui prioridade mais alta do que o `config.toml`.

## `workspace trust`

`workspace` agrupa as configurações relacionadas ao espaço de trabalho no `config.toml` em nível de usuário. O campo `require_trust` controla se o Kimi Code solicita confirmação de confiança quando um espaço de trabalho não confiável é aberto pela primeira vez; a confirmação é necessária por padrão.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `require_trust` | `boolean` | `true` | Exige confirmação de confiança ao abrir um espaço de trabalho não confiável pela primeira vez; `false` trata todos os espaços de trabalho como confiáveis e pula a solicitação de confiança na inicialização |

```toml
[workspace]
require_trust = false
```

::: warning Atenção
Desativar a exigência de confiança carrega servidores MCP em nível de projeto e outras configurações restritas por confiança sem confirmação. Use essa opção apenas quando todos os espaços de trabalho já forem confiáveis. Isso não altera modos de permissão, aprovações de ferramentas ou proteções de comandos perigosos.
:::

As alterações entram em vigor com o comando `/reload`; uma TUI em execução não exibe uma caixa de diálogo retroativa de confiança na inicialização. `KIMI_CODE_TRUST_WORKSPACE=1` permanece como uma sobrescrita independente de confiança por processo, e um valor falso não restaura o requisito da primeira abertura quando `require_trust` for `false`. Registros de confiança existentes são preservados e usados novamente se a exigência for reativada.

<!--
## `experimental`

`experimental` armazena sobrescritas persistentes para flags de recursos experimentais. Atualmente, `micro_compaction` é a única entrada voltada ao usuário e tem como padrão `false`; defina como `true` para ativar o corte automático de resultados antigos de ferramentas grandes.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `micro_compaction` | `boolean` | `false` | Remove resultados antigos de ferramentas grandes do contexto enquanto preserva a conversa recente |
-->

## `services`

`services` configura dois serviços integrados: busca na web (`moonshot_search`) e busca/extração web (`moonshot_fetch`). Apenas essas duas chaves fixas são reconhecidas; outras chaves são ignoradas. Ambas as entradas compartilham os mesmos campos:

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `base_url` | `string` | Não | URL da API do serviço |
| `api_key` | `string` | Não | Chave de API |
| `oauth` | `table` | Não | Referência de credencial OAuth, mesma estrutura de `providers.*.oauth` |
| `custom_headers` | `table<string, string>` | Não | Cabeçalhos HTTP personalizados anexados a cada requisição |

`base_url` e `api_key` também podem vir de variáveis de ambiente, que têm prioridade sobre o arquivo de configuração: `KIMI_WEB_SEARCH_BASE_URL` / `KIMI_WEB_SEARCH_API_KEY` para `moonshot_search` e `KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY` para `moonshot_fetch`. Uma URL base via ambiente define um endpoint de serviço separado, portanto a chave de API persistida, a referência OAuth e os cabeçalhos personalizados não são repassados a ele; defina a chave de API correspondente no ambiente quando esse endpoint exigir autenticação. Uma chave de API via ambiente sem uma URL base via ambiente mantém o endpoint e cabeçalhos personalizados configurados, mas substitui as duas formas de credenciais configuradas. Definir a URL base e a chave de API por meio do ambiente sem nenhuma seção de configuração também ativa o serviço.

```toml
[services.moonshot_search]
base_url = "https://api.moonshot.cn/v1/search"
api_key = "sk-xxx"

[services.moonshot_fetch]
base_url = "https://api.moonshot.cn/v1/fetch"
api_key = "sk-xxx"
```

## `permission`

`permission` define regras de permissão carregadas automaticamente na inicialização de uma sessão, controlando se o Agente precisa da confirmação do usuário antes de chamar uma ferramenta. As regras são escritas como uma matriz de tabelas `[[permission.rules]]`, avaliadas na ordem; a primeira regra correspondente entra em vigor.

Você também pode definir `dangerous_command_guard = false` sob `[permission]` para desativar completamente todas as políticas de confirmação dos mecanismos de proteção integrados: comandos perigosos, acesso a arquivos sensíveis como `.env` ou `id_rsa` e acesso a caminhos de controle do git deixam de solicitar confirmação no modo *Always Ask* (Perguntar Sempre) e *Ask When Needed* (Perguntar quando necessário) (essas políticas nunca ficam ativas no modo *Never Ask*); o padrão é `true`. A variável de ambiente `KIMI_CODE_DANGEROUS_COMMAND_GUARD=false` sobrescreve a configuração do arquivo. Com todas as proteções embutidas desligadas, apenas regras `ask` que você mesmo tenha configurado continuarão exibindo alertas no modo *Ask When Needed*; no modo *Always Ask*, ferramentas não aprovadas automaticamente continuam a solicitar confirmação normalmente. O bloqueio rígido que impede `Read`/`Write`/`Edit` de tocar em arquivos secretos permanece em vigor. Use esta opção apenas em ambientes que já filtram comandos fora do agente.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `decision` | `string` | Sim | Ação em caso de correspondência: `allow` (permitir imediatamente), `deny` (rejeitar imediatamente), `ask` (perguntar a cada execução) |
| `scope` | `string` | Não | Escopo da regra: `turn-override`, `session-runtime`, `project`, `user`; o padrão é `user` |
| `pattern` | `string` | Sim | Padrão de correspondência no formato `NomeDaFerramenta` ou `NomeDaFerramenta(padrao-argumento)`, ex: `Read` ou `Bash(rm -rf*)` |
| `reason` | `string` | Não | Descrição da regra para depuração e auditoria |

Os nomes das ferramentas integradas estão listados em [Ferramentas integradas](../reference/tools.md). A maioria das ferramentas integradas que aceitam argumentos em regras definem seu próprio assunto de correspondência, como `Bash(comando-padrao)` ou `Read(caminho-padrao)`. O `AgentSwarm`, ferramentas MCP e ferramentas personalizadas só podem ser filtrados pelo nome da ferramenta; padrões de argumento não são suportados para eles.

```toml
[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "allow"
pattern = "Grep"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[permission.rules]]
decision = "ask"
pattern = "Bash"
```

::: tip Dica
As declarações do servidor MCP são configuradas em `~/.kimi-code/mcp.json` ou no `.kimi-code/mcp.json` local do projeto, não no `config.toml`. O ponto de entrada da configuração interativa é o `/mcp-config`; veja [Model Context Protocol](../customization/mcp.md).
:::

## `environments`

`environments` declara ambientes remotos — hosts SSH, contêineres compatíveis com Docker ou comandos de inicialização personalizados — aos quais as sessões podem se vincular para que as ferramentas do agente sejam executadas no ambiente de destino. Veja [Ambientes remotos](../guides/remote-environment.md) para o passo a passo dos recursos, limites e restrições.

Cada entrada é identificada por seu id de ambiente: no máximo 64 caracteres, sem espaços em branco no início ou no fim, e com `local` e `default` sendo palavras reservadas. Em uma mesma entrada, `type` e `command` são mutuamente exclusivos.

Diretórios de trabalho remotos devem ser caminhos POSIX absolutos ou caminhos de unidade do Windows; caminhos relativos e `~` não são expandidos. Veja [Destinos Windows](../guides/remote-environment.md#windows-targets) para requisitos do Git Bash e do inicializador.

O campo opcional `default` de nível superior nomeia o ambiente ao qual uma sessão se vincula quando a criação não especificar um. Ele deve fazer referência a uma entrada configurada, e essa entrada deve definir `defaultCwd` — uma vinculação combina um ambiente com um diretório de trabalho, portanto um padrão sem diretório ficaria inconsistente. Sem um `default`, essas sessões são iniciadas no ambiente `local`. O comando `/new` da TUI não usa esse padrão: ele mantém o ambiente atual. Veja [Ambientes remotos](../guides/remote-environment.md).

### Entradas SSH

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `type` | `string` | Sim | `"ssh"` |
| `host` | `string` | Sim | Host SSH; iniciado através do `ssh` do sistema, de modo que configurações em `~/.ssh/config` (usuário, porta, chave, `ProxyJump`, `ControlMaster`) se aplicam |
| `remoteBin` | `string` | Não | Caminho do executável no destino; assume o padrão `~/.kimi-code/bin/kimi`. Destinos Windows exigem o nome exato do executável no `PATH` do destino, como `kimi`, em vez de um caminho absoluto do Windows |
| `defaultCwd` | `string` | Não | Preenchimento prévio do diretório de trabalho ao vincular uma sessão; não é validado localmente |

### Entradas Docker

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `type` | `string` | Sim | `"docker"` |
| `container` | `string` | Sim | Nome ou ID de um contêiner em execução; anexado via `docker exec` |
| `context` | `string` | Não | Contexto do Docker (por exemplo `orbstack`) |
| `remoteBin` | `string` | Não | Caminho do executável dentro do contêiner; o padrão é `~/.kimi-code/bin/kimi` sob o diretório do usuário do contêiner. O inicializador executa via `docker exec … sh -c`, então o `~` inicial é expandido pelo shell do contêiner |
| `defaultCwd` | `string` | Não | Preenchimento prévio do diretório de trabalho ao vincular uma sessão |

### Entradas de Comando

Forma genérica de inicialização, para qualquer ambiente não coberto pelos inicializadores integrados (máquinas OrbStack, `kubectl exec`, Apple Container, sandboxes gerenciados). O comando e os `args` descrevem como alcançar o destino: o inicializador deve executar os argumentos a seguir no destino, assim como `ssh host`, `kubectl exec -i pod --` e `docker exec -i container` fazem. O Kimi Code anexa `<remoteBin> exec-server` aos `args`, a menos que os `args` já invoquem `exec-server`.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `command` | `string` | Sim | Executável de inicialização: um nome resolvido no `PATH` ou um caminho absoluto. Uma resolução dentro do diretório de trabalho é recusada para evitar que o projeto substitua o inicializador por um binário de mesmo nome |
| `args` | `array<string>` | Não | Argumentos de inicialização que alcançam o destino. Quando um argumento já invocar `exec-server` (por exemplo `--command "~/.kimi-code/bin/kimi exec-server"`), nada será anexado e os argumentos serão executados exatamente como escritos |
| `env` | `table<string, string>` | Não | Ambiente para o processo do inicializador na sua máquina; nunca é propagado para comandos executados no destino |
| `remoteBin` | `string` | Não | Caminho do executável no destino, anexado após os `args`; o padrão é `~/.kimi-code/bin/kimi`. Use um caminho simples sem espaços ou caracteres especiais de shell. O `~` só se expande quando o inicializador executa os argumentos por um shell no destino, como faz o SSH; inicializadores que passam os argumentos diretamente, como `kubectl exec` e `docker exec`, precisam de um caminho absoluto |
| `defaultCwd` | `string` | Não | Preenchimento prévio do diretório de trabalho ao vincular uma sessão |

```toml
[environments]
default = "dev-box"

[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/home/me/projects"

[environments.dev-container]
type = "docker"
container = "myapp-dev"

[environments.sandbox]
command = "sandbox"
args = ["ssh", "i-1234567890", "--"]
env = { SANDBOX_TOKEN = "..." }
defaultCwd = "/home/me/kimi-code"

[environments.k8s]
command = "kubectl"
args = ["exec", "-i", "dev-pod", "--"]
remoteBin = "/root/.kimi-code/bin/kimi"
defaultCwd = "/workspace"
```

## `tui.toml`

Junto com o `config.toml`, o CLI mantém preferências da interface de terminal e do cliente em um arquivo parceiro `tui.toml` no mesmo diretório (`~/.kimi-code/tui.toml`, ou `$KIMI_CODE_HOME/tui.toml` quando sobrescrito). Ele é criado com valores padrão na primeira execução, e os comandos interativos `/config`, `/theme` e `/editor` gravam nele automaticamente, de modo que raramente é preciso editá-lo manualmente. Se o arquivo estiver malformado, o CLI reverte para os padrões e exibe um aviso em vez de falhar ao iniciar.

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `theme` | `string` | `auto` | Tema de cores: `auto`, `dark`, `light` ou o nome de um [tema personalizado](../customization/themes.md) |
| `tui_mode` | `string` | `regular` | Layout da interface: `regular` renderiza no histórico do terminal (*scrollback*); `fullscreen` (experimental) torna partes da interface interativas com o mouse para uma experiência mais fluida |
| `render_latex` | `boolean` | `true` | Renderiza expressões matemáticas LaTeX em mensagens Markdown como texto Unicode; `false` mantém o código-fonte bruto |
| `disable_paste_burst` | `boolean` | `false` | Desativa a alternativa de colagem rápida sem suporte a colagem colcheada (*non-bracketed paste burst*) que evita que colagens rápidas de várias linhas sejam enviadas linha por linha |
| `cache_expiry_hint` | `boolean` | `true` | Ao retomar ou enviar após uma longa inatividade, avisa que o cache de contexto pode ter expirado e oferece compactar ou iniciar nova sessão (apenas motor v2) |
| `auto_session_title` | `boolean` | `true` | Permite que a TUI gere automaticamente o título da sessão após o primeiro turno concluído; `false` desativa apenas a TUI, sem afetar o gatilho global `auto_session_title` em `config.toml` |
| `[editor].command` | `string` | `""` | Comando do editor externo para compor entradas longas; vazio reverte para `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | Define se notificações de área de trabalho serão enviadas |
| `[notifications].notification_condition` | `string` | `unfocused` | Quando notificar: `unfocused` (apenas quando o terminal não estiver em foco) ou `always` (sempre) |
| `[upgrade].auto_install` | `boolean` | `true` | Define se novas versões serão instaladas automaticamente |
| `[status_line].items` | `string[]` | `[]` | Slots integrados na primeira linha do rodapé e sua ordem: `mode`, `goal`, `model`, `tasks`, `cwd`, `git`, `tips`; IDs desconhecidos são pulados com um aviso |
| `[status_line].command` | `string` | `""` | Comando de linha de status personalizado: a primeira linha de saída (stdout) substitui o rodapé, e um snapshot JSON é passado via stdin; limitado a 300ms, com frequência máxima de uma vez por segundo; falhas revertem para o layout embutido |

<details>
<summary>Campos no snapshot JSON da entrada padrão (stdin)</summary>

Modelo, diretório atual (cwd), ramo do git (branch), modo de permissão, modo de planejamento, uso de contexto, ID da sessão, versão.

</details>

```toml
# ~/.kimi-code/tui.toml
theme = "auto" # "auto" | "dark" | "light" | nome de tema personalizado
tui_mode = "regular" # "regular" | "fullscreen" ("fullscreen" é experimental)
render_latex = true # false mantém equações LaTeX em mensagens como código-fonte bruto
disable_paste_burst = false # true desativa tratamento de colagem rápida sem colchetes
cache_expiry_hint = true # false desativa o diálogo de "cache expirado" ao retomar/enviar após inatividade
auto_session_title = true # false impede que a TUI gere título de sessão automaticamente após o primeiro turno

[editor]
command = "" # vazio utiliza $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

[upgrade]
auto_install = true

# [status_line]
# items = ["mode", "goal", "model", "tasks", "cwd", "git", "tips"]
# command = "~/.kimi-code/statusline.sh"
```

As alterações são aplicadas no próximo início ou imediatamente com o comando `/reload-tui` (que recarrega apenas o `tui.toml`); o comando `/reload` recarrega tanto o `config.toml` quanto o `tui.toml`.

## Configuração local do projeto

Além dos arquivos de nível de usuário em `~/.kimi-code`, o Kimi Code lê um arquivo de configuração local do projeto em `<project-root>/.kimi-code/local.toml`. Ele armazena configurações específicas de um checkout de projeto e que normalmente não devem ser compartilhadas com a equipe.

Versões anteriores do comando [`/add-dir`](../reference/slash-commands.md) gravavam diretórios salvos neste arquivo; versões atuais gravam-nos no registro do espaço de trabalho em `~/.kimi-code/projects.json`, tornando o `local.toml` um campo legado somente de leitura no qual nenhum processo escreve mais. Sessões de espaços de trabalho implícitos (acessados pelo diretório no terminal) ainda combinam o campo `additional_dir` com diretórios adicionais; sessões de espaços de trabalho explicitamente criados (gerenciados) não o leem mais. Para mover entradas legadas para o registro, use a ação de importação na caixa de diálogo de criação/edição de espaço de trabalho do cliente (suportada por [`GET /api/v1/workspaces/project-config-dirs`](../reference/server-api.md#get-apiv1workspacesproject-config-dirs)); entradas importadas passam a ser gerenciadas pelo registro e a remoção entra em vigor imediatamente.

### `[workspace]`

A tabela `[workspace]` agrupa configurações do espaço de trabalho em nível de projeto:

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | Não | Diretórios adicionais do espaço de trabalho (caminhos absolutos, campo de compatibilidade herdada); gravado por versões antigas do `/add-dir` e nunca gravado por versões atuais; ainda é mesclado em sessões de espaço de trabalho implícito e ignorado por espaços de trabalho gerenciados |

```toml
[workspace]
additional_dir = ["/caminho/absoluto/para/compartilhado"]
```

Como os diretórios são armazenados como caminhos absolutos especificamente vinculados à sua máquina, recomendamos adicionar `.kimi-code/local.toml` ao arquivo `.gitignore` do seu projeto para que ele não seja incluído nos commits.

Além do `local.toml`, o diretório `.kimi-code/` do projeto também pode conter o `mcp.json` (servidores MCP do projeto), que é protegido por validação de confiança: ele entra em vigor somente após você confirmar a confiança na pasta através do aviso de inicialização. Veja [Model Context Protocol](../customization/mcp.md).

## Próximos passos

- [Provedores e modelos](./providers.md) — Exemplos de conexão para cada tipo de provedor (Kimi, Claude, OpenAI, Gemini)
- [Substituições de configuração](./overrides.md) — Regras de prioridade para opções de CLI, arquivo de configuração e variáveis de ambiente
- [Variáveis de ambiente](./env-vars.md) — Lista completa de variáveis de tempo de execução, como `KIMI_CODE_HOME`