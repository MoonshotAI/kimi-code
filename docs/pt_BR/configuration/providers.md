# Provedores e modelos

O Kimi Code CLI oferece suporte à conexão simultânea com várias plataformas de LLM: login com um clique por meio do serviço gerenciado do Kimi Code, conexão com o Claude usando uma chave de API da Anthropic ou conexão com serviços de inferência de terceiros por meio do protocolo compatível com OpenAI. Cada provider corresponde a um protocolo de API específico; os modelos são declarados sobre os providers com seu próprio nome, tamanho de contexto e capacidades. Esta página explica como configurar cada tipo de provider em `config.toml`.

## Tipos de provider compatíveis

O campo `type` na tabela `providers` determina qual implementação de protocolo será usada:

| Type | Protocol | Typical use |
| --- | --- | --- |
| [`kimi`](#kimi) | OpenAI-compatible | Serviço gerenciado do Kimi Code, chave de API da Kimi Platform |
| [`anthropic`](#anthropic) | Anthropic Messages | Família de modelos Claude |
| [`openai`](#openai) | OpenAI Chat Completions | OpenAI e serviços compatíveis, DeepSeek, Qwen etc. |
| [`openai_responses`](#openai_responses) | OpenAI Responses API | Nova interface Responses da OpenAI |
| [`google-genai`](#google-genai) | Google GenAI | API do Gemini |
| [`vertexai`](#vertexai) | Google GenAI on Vertex | Google Cloud Vertex AI |

Todos os providers se comunicam com os modelos no modo de streaming por padrão. Capacidades como thinking, vision e tool use são associadas automaticamente com base no prefixo do nome do modelo, portanto, normalmente, você não precisa declará-las manualmente.

**Prioridade das credenciais**: campo `api_key` direto > chave da sub-tabela `[providers.<name>.env]` > se ambos estiverem ausentes, a inicialização falhará com um erro. O CLI não utiliza as variáveis de ambiente do shell como fallback para credenciais. Consulte [Config overrides: provider credentials](./overrides.md#provider-credentials).

## `/provider` — gerenciamento interativo de providers

Prefere não editar o TOML manualmente? Digite `/provider` na TUI para abrir o **provider manager**, onde você pode adicionar ou remover providers de forma interativa.

![The /provider provider manager](../../media/provider-manager.jpg)

O manager exibe os providers como uma lista de entradas agrupadas por origem. Navegação:

- ↑/↓ para mover o cursor, ←/→ para mudar de página
- `d` para excluir o provider atual (com confirmação `[y/N]`)
- Pressione Enter na linha `[ Add New Platform ]` para adicionar um novo provider

Há dois caminhos ao adicionar:

- **Known third-party provider**: busca o catálogo de modelos em [models.dev](https://models.dev/), seleciona um provider → insere uma chave de API → seleciona um modelo padrão. Vendors cujo protocolo não é declarado pelo catálogo (por exemplo, xai, openrouter e outros vendors com SDK específico) são importados como compatíveis com OpenAI, com uma observação "guessed"; quando o catálogo não fornece um endpoint utilizável, um prompt para a base URL é exibido primeiro; protocolos proprietários (Amazon Bedrock, Cohere) e protocolos explícitos não reconhecidos são recusados. Modelos obsoletos e em status alpha são excluídos da lista de importação. Se o catálogo público não estiver acessível, o CLI utiliza um snapshot integrado do catálogo, portanto, a importação continua funcionando offline ou em redes bloqueadas
- **Custom registry (api.json)**: cole uma URL de registry personalizado e um Bearer token; o CLI cria automaticamente as entradas `providers` / `models`. Em inicializações posteriores, os providers da mesma URL de registry são atualizados em conjunto, de modo que adições, remoções e alterações nos metadados dos modelos no upstream sejam sincronizadas.

::: warning
Contas gerenciadas do Kimi Code OAuth autenticadas por meio de `/login` não aparecem em `/provider`. Use `/login` e `/logout` para gerenciá-las.
:::

As mesmas operações também estão disponíveis em ambientes não interativos por meio do comando de shell: [`kimi provider`](../reference/kimi-command.md#kimi-provider).

## `kimi`

Para conectar à interface compatível com OpenAI da Moonshot AI, incluindo o serviço gerenciado do Kimi Code e as chaves de API da Kimi Platform.

- `base_url` padrão: `https://api.moonshot.ai/v1`
- Nomes das chaves de credencial: `KIMI_API_KEY`, `KIMI_BASE_URL`
- Capacidade adicional: suporta upload de vídeo

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

> Ao usar o serviço gerenciado do Kimi Code, executar `/login` configura automaticamente `base_url` e as credenciais, portanto, nenhuma configuração manual é necessária.

## `anthropic`

Para conectar à API do Claude. Os modelos Claude padrão ativam automaticamente vision, tool use e Thinking (quando compatíveis); modelos personalizados ou não abrangidos precisam ter `capabilities` declaradas explicitamente em `[models.<alias>]`.

- `base_url` padrão: segue o padrão do Anthropic SDK
- Nomes das chaves de credencial: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- `max_tokens` padrão: inferido por modelo. Para substituir esse valor, defina `max_output_size` no alias do modelo

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # opcional; omita para usar o padrão inferido pelo modelo
```

## `openai`

Para conectar ao protocolo OpenAI Chat Completions, bem como a qualquer serviço de terceiros compatível com esse protocolo (substitua `base_url` conforme necessário).

Modelos de reasoning de terceiros (DeepSeek, Qwen, One API etc.) funcionam imediatamente: o CLI lida automaticamente com o campo `reasoning_content` e a injeção de `reasoning_effort`. Se o seu gateway retornar o conteúdo de reasoning em um nome de campo fora do padrão, defina `reasoning_key` no alias do modelo para substituí-lo.

- `base_url` padrão: `https://api.openai.com/v1`
- Nomes das chaves de credencial: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

Corresponde à nova API Responses da OpenAI e sempre opera no modo de streaming. A configuração é a mesma de `openai`.

- `base_url` padrão: `https://api.openai.com/v1`
- Nomes das chaves de credencial: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

Para conectar diretamente à API do Google Gemini. As capacidades de Thinking, vision e multimodal são detectadas automaticamente pelo nome do modelo.

- Nome da chave de credencial: `GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

Para direcionar as solicitações por meio de um proxy ou gateway compatível com Gemini, defina `base_url` (ou a variável de ambiente `GOOGLE_GEMINI_BASE_URL`); quando omitido, o padrão do SDK `https://generativelanguage.googleapis.com` é utilizado.

> Informe somente a raiz do host. O Google GenAI SDK adiciona a versão e o caminho da API por conta própria (por exemplo, `/v1beta/models/<model>:generateContent`), portanto, adicionar `/v1beta` ao final faria com que `/v1beta/v1beta/…` fosse gerado.

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
base_url = "https://your-gateway.example"
```

## `vertexai`

Compartilha a mesma implementação de `google-genai`; definir `type = "vertexai"` alterna para o caminho de acesso do Vertex AI.

A autenticação segue o fluxo padrão do Google Cloud ADC (`gcloud auth application-default login` ou um JSON de service account em `GOOGLE_APPLICATION_CREDENTIALS`); essa parte não está relacionada ao Kimi Code. **O ID do projeto e a região devem ser escritos na sub-tabela `[providers.vertexai.env]`**. Simplesmente executar `export GOOGLE_CLOUD_PROJECT` no shell não será lido pelo CLI.

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # autenticação única
kimi
```

Para direcionar as solicitações do Vertex por meio de um endpoint personalizado (por exemplo, um endpoint com proxy), defina `base_url` (ou a variável de ambiente `GOOGLE_VERTEX_BASE_URL`); quando omitido, o host regional padrão `*-aiplatform.googleapis.com` do SDK é utilizado. Assim como em `google-genai`, informe somente a raiz do host. O SDK adiciona `/v1beta1/publishers/google/models/…` por conta própria.

## OAuth e injeção de credenciais

O serviço gerenciado do Kimi Code utiliza OAuth em vez de chaves de API estáticas. Após executar `/login`, a cadeia de ferramentas de autenticação integrada grava e atualiza automaticamente as credenciais, portanto, nenhuma configuração manual no `config.toml` é necessária.

## Próximos passos

- [Configuration files](./config-files.md) — referência completa dos campos das tabelas `providers` e `models`
- [Config overrides](./overrides.md) — regras de prioridade para resolução das credenciais dos providers
- [Environment variables](./env-vars.md) — nomes das chaves de credencial para cada tipo de provider