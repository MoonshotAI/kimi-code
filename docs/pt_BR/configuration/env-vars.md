# Variáveis de ambiente

O Kimi Code CLI usa variáveis de ambiente para controlar um pequeno número de comportamentos de execução: mover o diretório de dados, desativar a telemetria e trocar de modelo temporariamente sem alterar o arquivo de configuração.

::: warning Importante: as chaves de API não são configuradas aqui
Variáveis de credencial como `KIMI_API_KEY`, `ANTHROPIC_API_KEY` e `OPENAI_API_KEY` **não** são lidas automaticamente das variáveis de ambiente do shell. Executar `export KIMI_API_KEY=xxx` no terminal não fornece a chave a nenhum provedor. Elas devem ser escritas no `config.toml`, em `[providers.<name>]` ou na subtabela `[providers.<name>.env]`.

As únicas exceções são a família `KIMI_MODEL_*` e o campo `api_key_env` de um provedor, dois canais explícitos que *de fato* leem credenciais do shell. Consulte [Definir um modelo a partir de variáveis de ambiente](#definir-um-modelo-a-partir-de-variaveis-de-ambiente-kimi_model_) e [Nomes das chaves de credencial do provedor](#nomes-das-chaves-de-credencial-do-provedor-gravados-no-configtoml).

Para mais contexto, consulte [Substituições de configuração: credenciais do provedor](./overrides.md#provider-credentials).
:::

## Caminhos principais

### `KIMI_CODE_HOME`

Substitui o diretório raiz de dados; o padrão é `~/.kimi-code`. Depois de definida, o arquivo de configuração, as sessões, os logs, as credenciais OAuth e todos os outros dados passam a ficar no novo caminho:

```sh
export KIMI_CODE_HOME="/path/to/custom/kimi-code"
```

> Certifique-se de que o diretório tenha permissão de escrita. Várias instâncias do `kimi` que compartilham o mesmo `KIMI_CODE_HOME` compartilharão os arquivos de configuração e de credenciais.

Para a estrutura completa do diretório de dados, consulte [Localização dos dados](./data-locations.md).

### `KIMI_DISABLE_TELEMETRY`

Defina como `1` para desativar o envio de telemetria anônima (também aceita `true`, `yes` e `y`, sem distinção entre maiúsculas e minúsculas):

```sh
export KIMI_DISABLE_TELEMETRY=1
```

### Família `KIMI_MODEL_*`

Troque de modelo temporariamente sem modificar o `config.toml`: quando `KIMI_MODEL_NAME` está definida, o CLI sintetiza um provedor temporário em memória, e a alteração não persiste após a reinicialização. Consulte [Definir um modelo a partir de variáveis de ambiente](#definir-um-modelo-a-partir-de-variaveis-de-ambiente-kimi_model_).

### `KIMI_CODE_CUSTOM_HEADERS`

::: info Adicionado
Adicionado na versão 0.20.2.
:::

Anexa cabeçalhos HTTP personalizados a todas as requisições de modelo de saída: tanto as requisições de chat com o LLM (em todos os protocolos de provedor) quanto as requisições de listagem de `/models` os incluem. Útil quando um gateway roteia por cabeçalho, por exemplo, para fixar um cluster específico:

```sh
export KIMI_CODE_CUSTOM_HEADERS=$'X-Gateway-Cluster: my-cluster\nX-Custom-Tag: debug'
```

O formato espelha o de `ANTHROPIC_CUSTOM_HEADERS`: linhas `Name: Value` separadas por quebra de linha. Nomes e valores têm os espaços das pontas removidos, e linhas sem dois-pontos são ignoradas.

> Precedência: os cabeçalhos de identidade do Kimi (`User-Agent`, `X-Msh-*`) e o `custom_headers` de um provedor no `config.toml` (consulte [Arquivos de configuração](./config-files.md#providers)) substituem as entradas de mesmo nome definidas aqui. A autenticação depende do protocolo: nos protocolos `kimi`, `openai` e `openai_responses`, uma entrada `Authorization` exata substitui o token bearer gerado, enquanto as requisições de listagem de `/models` mantêm a própria autenticação. Uma variação de maiúsculas e minúsculas, como `authorization`, nunca é tratada como o mesmo nome. Ela é mesclada com o cabeçalho real, o que pode quebrar as requisições. Não use esta variável para autenticação nem para outros cabeçalhos reservados. Use `custom_headers` quando os cabeçalhos precisarem ser diferentes para cada provedor.

## Nomes das chaves de credencial do provedor (gravados no config.toml)

Os nomes de chave abaixo não são lidos diretamente do shell. São nomes de chave gravados dentro da subtabela `[providers.<name>.env]` do `config.toml`, servindo como valores de fallback para `api_key` / `base_url`. O CLI lê apenas do arquivo de configuração, não de `process.env`.

Esses nomes convencionais são fixos para cada tipo de provedor. Se você preferir manter a chave no ambiente do shell com um nome de sua escolha, defina [`api_key_env`](./config-files.md#providers) no provedor: o CLI passa então a ler a chave dessa variável a cada requisição.

Esse desenho permite manter as convenções de nomes de chave que você já conhece e, ao mesmo tempo, centralizar o gerenciamento de segredos no arquivo de configuração:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

Nomes de chave por provedor:

| Chave | Provedor aplicável | Padrão |
| --- | --- | --- |
| `KIMI_API_KEY` | Kimi / Moonshot | Nenhum |
| `KIMI_BASE_URL` | Kimi / Moonshot | `https://api.moonshot.ai/v1` |
| `ANTHROPIC_API_KEY` | Anthropic | Nenhum |
| `ANTHROPIC_BASE_URL` | Anthropic | Segue o padrão do SDK da Anthropic |
| `OPENAI_API_KEY` | OpenAI (`openai` e `openai_responses`) | Nenhum |
| `OPENAI_BASE_URL` | OpenAI (`openai` e `openai_responses`) | `https://api.openai.com/v1` |
| `GOOGLE_API_KEY` | Google GenAI, Vertex AI | Nenhum |
| `VERTEXAI_API_KEY` | Vertex AI | Nenhum |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI | Nenhum |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI | Nenhum |

::: warning
`GOOGLE_APPLICATION_CREDENTIALS` (caminho para um arquivo JSON de conta de serviço) é a única exceção que passa pelo mecanismo de variáveis de ambiente do sistema. Ela é lida diretamente pelo SDK do Google, por meio do fluxo ADC padrão; o CLI não participa. Todos os outros nomes de chave devem ser colocados na subtabela `[providers.<name>.env]` para que tenham efeito.
:::

Para a referência completa dos tipos de provedor e de seus campos, consulte [Provedores e modelos](./providers.md).

## OAuth e serviços gerenciados

Este grupo de variáveis redireciona a autenticação OAuth e os endpoints dos serviços gerenciados para um ambiente próprio (self-hosted) ou de teste. Elas não são necessárias no uso cotidiano.

| Variável | Finalidade | Padrão |
| --- | --- | --- |
| `KIMI_CODE_OAUTH_HOST` | Host de autenticação OAuth; maior prioridade | Recorre a `KIMI_OAUTH_HOST` quando não definida |
| `KIMI_OAUTH_HOST` | Host de autenticação OAuth; fallback de `KIMI_CODE_OAUTH_HOST` | Recorre a `https://auth.kimi.com` quando não definida |
| `KIMI_CODE_BASE_URL` | URL base da API gerenciada usada após o login OAuth | `https://api.kimi.com/coding/v1` |

::: warning
`KIMI_CODE_BASE_URL` (serviço gerenciado via OAuth, voltado para `kimi.com`) e `KIMI_BASE_URL` (conexão direta com chave de API, voltada para `moonshot.ai`) são duas variáveis distintas. Use cada uma no contexto apropriado.
:::

## Definir um modelo a partir de variáveis de ambiente (`KIMI_MODEL_*`)

Quer trocar de modelo para testes sem mexer no `config.toml`? Quando `KIMI_MODEL_NAME` está definida, o CLI sintetiza em memória um provedor temporário e um alias de modelo a partir das variáveis `KIMI_MODEL_*`; nada é gravado de volta no arquivo de configuração. Essas variáveis têm prioridade sobre `default_model` no `config.toml`, mas a opção `-m <alias>` na inicialização ainda tem a maior prioridade.

```sh
export KIMI_MODEL_NAME="kimi-for-coding"
export KIMI_MODEL_API_KEY="YOUR_API_KEY"
export KIMI_MODEL_BASE_URL="https://api.example.com/v1"
export KIMI_MODEL_MAX_CONTEXT_SIZE="262144"
export KIMI_MODEL_CAPABILITIES="image_in,thinking"
kimi
```

Lista completa de variáveis:

| Variável | Obrigatória | Finalidade | Padrão |
| --- | --- | --- | --- |
| `KIMI_MODEL_NAME` | Sim (também é a chave de ativação) | ID do modelo enviado à API | — |
| `KIMI_MODEL_API_KEY` | Sim | Chave de API | — |
| `KIMI_MODEL_PROVIDER_TYPE` | Não | Tipo de provedor: `kimi`, `anthropic`, `openai` | `kimi` |
| `KIMI_MODEL_BASE_URL` | Não | URL base da API | Cada tipo tem o seu padrão |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | Não | Tamanho máximo do contexto (tokens) | `262144` (256 K) |
| `KIMI_MODEL_CAPABILITIES` | Não | Tags de capacidade separadas por vírgula, unidas às capacidades detectadas automaticamente | `image_in,thinking` |
| `KIMI_MODEL_DISPLAY_NAME` | Não | Nome exibido em `/model` | Recorre a `KIMI_MODEL_NAME` |
| `KIMI_MODEL_MAX_OUTPUT_SIZE` | Não | Limite de saída por requisição (somente `anthropic`); quando definido, substitui o teto integrado do Claude | Padrão do modelo |
| `KIMI_MODEL_REASONING_KEY` | Não | Substituição do nome do campo de raciocínio (somente `openai`) | Detectado automaticamente |
| `KIMI_MODEL_THINKING_EFFORT` | Não | Nível de esforço de thinking: `low`/`medium`/`high`/`xhigh`/`max` | — |
| `KIMI_MODEL_ADAPTIVE_THINKING` | Não | Força o adaptive thinking a ficar ativado ou desativado (somente `anthropic`) | Inferido pelo nome do modelo |

Se `KIMI_MODEL_NAME` estiver definida, mas faltar alguma variável obrigatória, a inicialização falha imediatamente com uma mensagem de erro clara.

## Chaves de execução

Chaves que controlam o comportamento de subsistemas como telemetria, tarefas em segundo plano e o marketplace de plugins:

| Variável | Finalidade | Valores válidos |
| --- | --- | --- |
| `KIMI_DISABLE_TELEMETRY` | Desativa o envio de telemetria anônima | `1`, `true`, `yes`, `y` (sem distinção entre maiúsculas e minúsculas) |
| `KIMI_CODE_PASSWORD` | Credencial de autenticação paralela para o `kimi web`, recomendada ao vincular além do loopback (consulte [Notas de segurança](../guides/web.md#security-notes)) | Qualquer string não vazia; quando não definida, apenas o token é válido |
| `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` | Mantém as tarefas em segundo plano quando a sessão é fechada; maior prioridade que o `config.toml` (padrão: encerrá-las ao sair) | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS` | Limite de tarefas em segundo plano em execução simultânea; maior prioridade que `[background] max_running_tasks` (não definida = sem limite) | Inteiro positivo; valores inválidos são ignorados |
| `KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S` | Timeout padrão (em segundos) das tarefas `Bash` em segundo plano, também usado para rearmar comandos em primeiro plano movidos para o segundo plano; maior prioridade que `[task] bash_task_timeout_s` (`0` = sem timeout) | Inteiro não negativo; valores inválidos são ignorados |
| `KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE` | O que o `kimi -p` faz enquanto ainda há tarefas em segundo plano pendentes após o turno principal; maior prioridade que `[task] print_background_mode` | `exit`, `drain` ou `steer`; valores inválidos são ignorados |
| `KIMI_CODE_BACKGROUND_PRINT_WAIT_CEILING_S` | Limite de tempo real (em segundos) para a espera de drain/steer no modo print; maior prioridade que `[task] print_wait_ceiling_s` | Inteiro positivo; valores inválidos são ignorados |
| `KIMI_CODE_BACKGROUND_PRINT_MAX_TURNS` | Número máximo de novos turnos acionados pela conclusão de tarefas em segundo plano no modo print; maior prioridade que `[task] print_max_turns` | Inteiro positivo; valores inválidos são ignorados |
| `KIMI_IMAGE_MAX_EDGE_PX` | Limite da maior aresta (px) na compressão de imagens; maior prioridade que `[image] max_edge_px` (padrão `2000`) | Inteiro positivo; valores inválidos são ignorados |
| `KIMI_IMAGE_READ_BYTE_BUDGET` | Orçamento de bytes por imagem nas leituras de imagem iniciadas pelo modelo; maior prioridade que `[image] read_byte_budget` (padrão `262144`) | Inteiro positivo; valores inválidos são ignorados |
| `KIMI_CODE_PLUGIN_MARKETPLACE_URL` | Substitui o JSON do marketplace carregado por `/plugins`; padrão `https://code.kimi.com/kimi-code/plugins/marketplace.json` | Também aceita URLs `http://`, `file://` e caminhos locais |
| `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` | Limite de subagentes do AgentSwarm em execução simultânea durante a rampa inicial; não definida = sem limite | Inteiro positivo; valores inválidos causam falha imediata |
| `KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE` | Quantos escopos de subagentes concluídos permanecem residentes para retomada rápida; os mais antigos são removidos e reconstruídos sob demanda a partir do estado persistido (padrão `32`; `0` ou negativo = nunca remover) | Inteiro; valores inválidos causam falha imediata |
| `KIMI_CODE_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS` | Tempo real máximo (ms) que a remoção de um único escopo de subagente pode levar antes que a fila de remoção o ignore e siga adiante (padrão `15000`) | Inteiro positivo; valores inválidos causam falha imediata |
| `KIMI_SUBAGENT_TIMEOUT_MS` | Tempo real máximo (ms) que um único subagente `Agent` pode executar; maior prioridade que `[subagent] timeout_ms` | Inteiro positivo; valores inválidos recorrem à configuração ou ao padrão |
| `KIMI_CODE_SWARM_TIMEOUT_MS` | Tempo real máximo (ms) que um subagente `AgentSwarm` pode executar; maior prioridade que `[swarm] timeout_ms` | Inteiro positivo; valores inválidos recorrem à configuração ou ao padrão |
| `KIMI_CODE_IDENTITY_NAME` | Nome pelo qual o agente se chama no prompt de sistema; maior prioridade que `[identity] name`, nunca gravado de volta | Qualquer string não vazia; valores em branco são tratados como não definidos |
| `KIMI_CODE_IDENTITY_SLUG` | Token de produto do `User-Agent` e nome do cliente MCP; maior prioridade que `[identity] slug`; derivado do nome quando não definida | Qualquer string não vazia; normalizado para minúsculas, com sequências de caracteres não alfanuméricos reduzidas a `-` |
| `KIMI_CODE_BUILTIN_PRODUCT_SKILLS` | Oferece ao modelo as skills integradas que documentam o próprio Kimi Code; maior prioridade que `builtin_product_skills` | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_CODE_REPEAT_BREAKER` | Define se repetir a mesma chamada de ferramenta várias vezes seguidas injeta lembretes e, por fim, interrompe o turno à força. Quando não definida, permanece ativado | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off`; qualquer outro valor é ignorado |
| `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK` | Parâmetro experimental `fork` em `Agent`/`AgentSwarm`: inicia o subagente a partir de um instantâneo do histórico do chamador em vez de um contexto vazio; `KIMI_CODE_EXPERIMENTAL_FLAG=1` também o ativa | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_CODE_EXPERIMENTAL_TOOL_SELECT` | Carregamento experimental de ferramentas sob demanda: as ferramentas de servidores MCP marcados com `deferred: true` ficam fora da lista de ferramentas de nível superior e são carregadas via `select_tools`; também exige que o modelo declare a capacidade `dynamically_loaded_tools` — consulte [MCP](../customization/mcp.md#loading-tools-on-demand) | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_CODE_WATCH` | Anexa observadores do sistema de arquivos que recarregam a configuração e os arquivos do workspace; maior prioridade que `[watch] enabled` (padrão `true`) | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_CODE_SEARCH_WORKER` | Executa o índice de busca global em uma worker thread dedicada; maior prioridade que `[database] search` (padrão `true`) | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_CODE_PERSISTENCE_MINIDB_READMODEL` | Usa o read model baseado em minidb para a indexação de sessões; maior prioridade que `[database] base` (padrão `true`) | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_MCP_STARTUP_TIMEOUT_MS` | Timeout global padrão de conexão (ms) para servidores MCP; substitui o arquivo de configuração, mas o `startupTimeoutMs` do `mcp.json` ainda prevalece | Inteiro de `1` a `2147483647`; valores inválidos são ignorados |
| `KIMI_MCP_TOOL_TIMEOUT_MS` | Timeout global padrão de uma única chamada de ferramenta (ms) para servidores MCP; substitui o arquivo de configuração, mas o `toolTimeoutMs` do `mcp.json` ainda prevalece | Inteiro de `1` a `2147483647`; valores inválidos são ignorados |
| `KIMI_CODE_TRUST_WORKSPACE` | Marca o workspace atual como confiável, equivalente a escolher "Trust this folder" no prompt de confiança interativo; vale por processo e não grava um registro de confiança persistente | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_LOOP_MAX_STEPS_PER_TURN` | Máximo de etapas do Agent por turno; maior prioridade que `[loop_control] max_steps_per_turn` (`0` = ilimitado) | Inteiro não negativo; valores inválidos são ignorados |
| `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` | Máximo total de tentativas para uma etapa com falha (incluindo a primeira); maior prioridade que `[loop_control] max_attempts_per_step` | Inteiro não negativo; valores inválidos são ignorados |
| `KIMI_CODE_INFINITE_RETRY` | Repete indefinidamente as requisições de LLM com falha; backoff exponencial (limite de 32 s) respeitando `Retry-After`; abortar ainda cancela imediatamente | Verdadeiros: `1`/`true`/`yes`/`on`; falsos: `0`/`false`/`no`/`off` |
| `KIMI_TOKEN_COUNTING_STRATEGY` | Contagem de tokens de contexto informada externamente; maior prioridade que `[token_counting] strategy` | `measured+estimated`, `measured`, `estimated` (sem distinção entre maiúsculas e minúsculas); valores inválidos são ignorados |
| `KIMI_WEB_SEARCH_BASE_URL` | URL da API do serviço de busca na web (`WebSearch`); maior prioridade que o arquivo de configuração; credenciais e cabeçalhos personalizados não são encaminhados | String não vazia; valores em branco são ignorados |
| `KIMI_WEB_SEARCH_API_KEY` | Chave de API do serviço de busca na web (`WebSearch`); substitui tanto a chave configurada quanto a credencial OAuth | String não vazia; valores em branco são ignorados |
| `KIMI_WEB_FETCH_BASE_URL` | URL da API do serviço de fetch na web (`FetchURL`); maior prioridade que o arquivo de configuração; credenciais não são encaminhadas. Sem um endpoint, usuários autenticados recebem o serviço gerenciado de fetch do Kimi OAuth antes das requisições locais diretas | String não vazia; valores em branco são ignorados |
| `KIMI_WEB_FETCH_API_KEY` | Chave de API do serviço de fetch na web (`FetchURL`); substitui tanto a chave configurada quanto a credencial OAuth | String não vazia; valores em branco são ignorados |
| `KIMI_CODE_EXPERIMENTAL_FLAG` | Ativa todos os recursos experimentais registrados neste processo | `1`, `true`, `yes`, `on` |
| `KIMI_SHELL_PATH` | Substitui o caminho do Git Bash no Windows (usado quando a detecção automática falha) | Caminho absoluto |
| `KIMI_MODEL_MAX_COMPLETION_TOKENS` | Limite rígido de `max_completion_tokens` por etapa de LLM; aplica-se apenas ao provedor `kimi` | Inteiro positivo; `0` ou negativo desativa a limitação |
| `KIMI_MODEL_TEMPERATURE` | Temperatura de amostragem em todas as requisições; somente provedor `kimi` (global, independente de `KIMI_MODEL_NAME`) | Número, por exemplo `0.3` |
| `KIMI_MODEL_TOP_P` | `top_p` de amostragem nucleus em todas as requisições; somente provedor `kimi` (global) | Número, por exemplo `0.95` |
| `KIMI_MODEL_THINKING_EFFORT` | Força um nível de esforço de thinking (`thinking.effort`), ignorando o `support_efforts` declarado pelo modelo; somente provedor `kimi` | Um valor de esforço, por exemplo `max` |
| `KIMI_MODEL_THINKING_KEEP` | Repasse de thinking preservado: `thinking.keep` no `kimi`, uma edição `clear_thinking_20251015` no `anthropic`; substitui `[thinking] keep` | Um valor aceito pela API, por exemplo `all`; um valor de desativação (`false`/`0`/`no`/`off`/`none`/`null`) a desativa |
| `KIMI_CODE_NO_AUTO_UPDATE` | Desativa totalmente a verificação prévia de atualização: sem checagem, instalação em segundo plano nem prompt. O alias legado `KIMI_CLI_NO_AUTO_UPDATE` também é aceito | Verdadeiros: `1`/`true`/`yes`/`on` |
| `KIMI_DISABLE_CRON` | Desativa a ferramenta de tarefas agendadas (`CronCreate` rejeita novos agendamentos; as tarefas existentes não disparam) | `1` para desativar |

As variáveis `KIMI_CODE_INFINITE_RETRY`, `KIMI_CODE_IDENTITY_*` e `KIMI_CODE_BUILTIN_PRODUCT_SKILLS` são lidas pelo motor `agent-core-v2`.

## Logs de diagnóstico

Estas variáveis controlam o nível de log e a rotação de arquivos, e são lidas uma única vez, na inicialização do processo:

| Variável | Finalidade | Padrão |
| --- | --- | --- |
| `KIMI_LOG_LEVEL` | Nível de log: `off`, `error`, `warn`, `info`, `debug` | `info` |
| `KIMI_LOG_GLOBAL_MAX_BYTES` | Máximo de bytes por arquivo de log global | `6291456` (6 MB) |
| `KIMI_LOG_GLOBAL_FILES` | Número de arquivos de log globais a manter | `5` |
| `KIMI_LOG_SESSION_MAX_BYTES` | Máximo de bytes por arquivo de log de sessão | `5242880` (5 MB) |
| `KIMI_LOG_SESSION_FILES` | Número de arquivos de log de sessão a manter | `3` |

## Variáveis de ambiente do sistema

O CLI também lê várias variáveis padrão do sistema para detectar o ambiente de execução; ele não as modifica:

- `HOME`: usada para resolver o caminho de dados padrão
- `VISUAL`, `EDITOR`: comando do editor externo (`VISUAL` tem precedência)
- `PATH`: usada para localizar dependências como `rg`, `fd`, `fdfind` e `git`; no Windows, a detecção do Git Bash verifica cada `git.exe` encontrado no `PATH`, incluindo shims de gerenciadores de pacotes, como o Scoop
- `NO_COLOR`, `FORCE_COLOR`: controlam a saída colorida (seguindo a convenção do [no-color.org](https://no-color.org))
- `CI`: quando não vazia e diferente de `"0"`, desativa a detecção de tema e recorre ao tema escuro
- `TERM_PROGRAM`, `TERM`, `TMUX`: detectam recursos do terminal e o suporte a notificações
- `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`: detectam sessões gráficas do Linux (para os recursos de área de transferência e de imagem)
- `WSL_DISTRO_NAME`, `WSLENV`: detectam o WSL para a ponte de PowerShell da área de transferência
- `LOCALAPPDATA`: usada no Windows como fallback ao procurar o caminho de instalação do Git Bash

## Proxy HTTP

O Kimi Code respeita as variáveis de ambiente padrão de proxy em todo o tráfego de saída: chamadas à API de modelos, servidores MCP, ferramentas web, telemetria, login e verificações de atualização:

- `HTTP_PROXY` / `http_proxy`: proxy para requisições `http://`
- `HTTPS_PROXY` / `https_proxy`: proxy para requisições `https://`
- `ALL_PROXY` / `all_proxy`: proxy de fallback usado quando a variável específica do esquema não está definida; é onde um proxy SOCKS costuma ser configurado
- `NO_PROXY` / `no_proxy`: hosts separados por vírgula que ignoram o proxy

### Tipos de proxy e precedência

Há suporte tanto a proxies HTTP(S) quanto SOCKS. Um proxy SOCKS é reconhecido pelo esquema: `socks5://`, `socks5h://`, `socks4://` ou `socks://` (um alias de `socks5://`). Normalmente ele é definido por `ALL_PROXY` (a forma usada por ferramentas como Clash e V2RayN). Um proxy HTTP(S) tem precedência sobre `ALL_PROXY` no tráfego HTTP/HTTPS.

### Condições de ativação e endereços de loopback

O proxy só é aplicado quando uma dessas variáveis está definida; caso contrário, as conexões são feitas diretamente. Hosts de loopback (`localhost`, `127.0.0.1`, `::1`) sempre ignoram o proxy, de modo que um servidor local, como um servidor MCP em localhost, continua funcionando quando há um proxy configurado. Adicione seus próprios hosts internos a `NO_PROXY` para isentá-los também.

### Processos filhos do MCP

Servidores MCP via stdio executados como processos filhos do Node respeitam `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` automaticamente quando a versão do Node do processo filho oferece suporte a `NODE_USE_ENV_PROXY` (Node ≥ 22.21 ou ≥ 24.5); o proxy SOCKS se aplica apenas ao tráfego do próprio Kimi Code.

## Próximos passos

- [Substituições de configuração](./overrides.md) — como as variáveis de ambiente, as opções do CLI e o arquivo de configuração interagem por prioridade
- [Localização dos dados](./data-locations.md) — estrutura de diretórios afetada por `KIMI_CODE_HOME`
- [Provedores e modelos](./providers.md) — exemplos completos de conexão por tipo de provedor