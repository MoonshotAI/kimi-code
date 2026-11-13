# API do Servidor

O servidor local iniciado pelo `kimi web` expõe duas interfaces programáticas: uma API REST (`/api/v1`, além de `/api/v2/sessions` e `/api/v2/mcp`) e um fluxo de eventos WebSocket (`/api/v1/ws`). Esta página é um protocolo de referência para ambas. Para saber como iniciar o servidor e suas opções de linha de comando, consulte a referência [kimi command](./kimi-command.md#kimi-web); para um guia passo a passo que aborde completamente o assunto, veja o tópico [Conduzir uma sessão via API](#conduzir-uma-sessão-via-api) abaixo.

Essa página é uma referência curada e legível por humano: ela documenta os parâmetros, corpos de requisição e formatos de resposta de cada endpoint. O esquema preciso e legível por máquina de cada endpoint é definido pelos documentos de especificação em tempo real do servidor: `GET /openapi.json` (OpenAPI) e `GET /asyncapi.json` (AsyncAPI), ambos gerados a partir dos mesmos esquemas de validação que o servidor aplica em tempo de execução. Ambos exigem autenticação; caso essa página e a especificação em tempo real divergirem, a especificação em tempo real prevalece.

::: warning
Os APIs REST e WebSockets descritos nessa página são experimentais: a estabilidade da interface não é garantida, e endpoints, campos e tipos de eventos podem mudar em qualquer versão. Ao realizar integrações, baseie-se nos documentos `/openapi.json` e `/asyncapi.json` dispostos pela sua versão.
:::

## Conveções

### Endereço

O endereço padrão é `http://127.0.0.1:58627`. Quando a porta estiver ocupada, o servidor tentará novamente com a próxima porta (até 100 vezes); use `--port` / `--host` para alterar o bind. Múltiplas instâncias podem coexistir sobre um mesmo diretório home; instâncias em execução são registradas em `~/.kimi-code/server/instances/`.

### Autenticação

Todos os caminhos `/api/*` (incluindo `/openapi.json` e `/asyncapi.json`) exigem o token bearer, exceto:

- Requisições de preflight `OPTIONS`
- `GET /api/v1/healthz` (liveness probe)
- Ativos web estáticos (caminhos não`/api/`)

Como enviá-lo:REST usa o cabeçalho `Authorization: Bearer <token>`; o upgrade do WebSocket aceita o mesmo cabeçalho ou o subprotocolo `kimi-code.bearer.<token>`. A geração e rotação de tokens são abordadas em [Usando o Kimi Code no navegador: Primeiros passos](../guides/web.md#getting-started).

Falhas de autenticação retornam HTTP 401 com o codigo de envelope `40101`.Em binds não-loopback, uma origem que falhar na autenticação 10 vezes dentro de 60 segundos é banida por 60 segundos, período durante o qual toda requisição recebe HTTP 429 (código `42901`).

### Envelope de resposta

Toda resposta JSON é empacotada em um envelope uniforme:

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

- `code`: o resultado de negócio; `0` significa sucesso. Veja as faixas de códigos de erro abaixo.
- `data`: a carga útil(payload) em caso de sucesso. Note que alguns enevelopes de "erro" também carregam um `data` não nulo — por exemplo, resolver uma aprovação já resolvida retorna `40902` com `data.resolved` definido como `false` — portanto, os clientes devem verificar o `code` primeiro, e depois o `data`.
- `request_id`: um ULID para esta requisição. Os clientes podem fornecer um através do cabeçalho `X-Request-Id`; valores inválidos são regenerados pelo servidor.

O status HTTP é quase sempre 200; o resultado de negócio reside no `code`. Exceções:

| Situação | status HTTP |
| --- | --- |
| Falha de autenticação / limite de taxa (rate limit) | 401 / 429 |
| Provedor criado, catálogo de provedor importado | 201 |
| Provedor excluído | 204 |
| Endpoints binários/de streaming | 206 (Range) / 304 (ETag inalterado) onde suportado — as capacidades diferem por endpoint, veja[Endpoints Binários e de streaming](#Endpoints-binários-e-de-streaming) |
| `GET /api/v1/files/{file_id}` erros de download | 404 / 500 reais (ainda carregando um corpo de envelope) |

As respostas 201 ainda carregam o envelope padrão (`code` 0) — apenas a linha de status segue a convenção REST para criação de recursos. Uma resposta 204 não possui corpo por definição, então uma exclusão bem-sucedida é relatada pelo próprio código de status.

### Códigos de erro

Os códigos de erro são agrupados por faixa (band):

| Faixa | Significado | Exemplos |
| --- | --- | --- |
| `0` | Successo | |
| `400xx` | Requisição inválida (Bad request) | `40001` validação falhou (`details` lista cada campo), `40003` provedor é gerenciado via OAuth |
| `401xx` | Autenticação e prontidão (Auth and readiness) | `40101` não autorizado, `40110` nenhum provedor configurado, `40113` modelo não resolvido |
| `404xx` | Não encontrado (Not found) | `40401` sessão, `40408` servidor MCP, `40409` caminho do arquivo |
| `409xx` | Conflito de estado | `40901` sessão ocupada, `40902` aprovação já resolvida, `40922` condições da página não correspondem ao `page_token` |
| `410xx` | Expirado | `41001` tempo limite da aprovação esgotado, `41002` tempo limite da pergunta esgotado, `41003` arquivo temporário expirado |
| `413xx` | Tamanho ou limite excedido | `41302` leitura de arquivo acima de 10 MB, `41304` caminho escapa do diretório da sessão |
| `429xx` | Limite de taxa | `42901` banimento por falha de autenticação, `42902` excesso de fs watches |
| `500xx` | Erro interno do servidor | `50001` exceção não tratada, `50003` falha de persistência |
| `6xxxx` / `7xxxx` / `8xxxx` | Erros de runtime de ferramenta / provedor de LLM / passthrough do MCP; `msg` carrega o texto de upstream | |

### Paginação

Endpoints de lista vêm em dois estilos:

- **Estilo de cursor**: `before_id` / `after_id` (mutuamente exclusivos) mais `page_size` (1–100), respondendo com `{ items, has_more }`. Usado pela lista de sessões, lista de mensagens, transcrição, e outros.
- **`page_token`**: um token opaco (vinculado a um fingerprint das condições de consulta), usado por `POST /api/v1/search` e `GET /api/v2/sessions`. Alterar qualquer condição de consulta no meio da paginação invalida o token: v2 retorna `40922`, a busca retorna `40001`. `GET /api/v2/sessions` também oferece um modo stateless de número de página `page` como alternativa.

## Conduzir uma sessão via API

O fluxo mínimo com curl: verificar o servidor → criar uma sessão → assinar eventos → enviar um prompt → ler o histórico de volta. Os exemplos assumem que o servidor está rodando no endereço padrão e que o token está armazenado na variável de shell `TOKEN`.

1. Verificar o status do servidor:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/v1/meta
```

Toda resposta JSON é encapsulada em um envelope uniforme — `{ "code": 0, "msg": "success", "data": ..., "request_id": "..." }`. O resultado de negócio reside em `code` (`0` significa sucesso); o status HTTP relata apenas resultados em nível de transporte.

2. Criar uma sessão; `metadata.cwd` define o diretório de trabalho:

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"cwd": "/path/to/project"}}'
```

O `data.id` retornado (no formato `session_...`) é o id da sessão usado por todas as requisições subsequentes.

3. Conecte-se ao WebSocket e assine os eventos da sessão. Qualquer cliente WebSocket funciona; abaixo está um script Node.js sem dependências (o Node.js 22+ vem com um cliente `WebSocket` embutido):

```js
// subscribe.mjs — usage: TOKEN=... node subscribe.mjs session_...
const ws = new WebSocket('ws://127.0.0.1:58627/api/v1/ws', [
  `kimi-code.bearer.${process.env.TOKEN}`,
]);
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () =>
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      id: '1',
      payload: { session_ids: [process.argv[2]] },
    }),
  );
```

4. Envie um prompt:

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": [{"type": "text", "text": "Introduce this repository in one sentence"}]}'
```

O assinante vê, em ordem: `turn.started` (o turno começa) → `assistant.delta` (incrementos de texto em streaming) → `tool.call.started` / `tool.result` quando chamadas de ferramentas acontecem → `turn.ended` (o turno termina).

5. Ler o histórico de volta via REST a qualquer momento:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:58627/api/v1/sessions/<session_id>/messages?page_size=20"
```

## Endpoints REST

Os endpoints são agrupados por recurso abaixo. Um sufixo `:{action}` em um caminho é a convenção de ação — faça um POST para `path:action` em um único recurso para operações não-CRUD (como `:fork` e `:archive` em uma sessão).

### Servidor e metadados

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/healthz` | Liveness probe; isento de autenticação |
| `GET /api/v1/meta` | Versão do servidor, mapa de capacidades, `server_id`, flags experimentais |
| `POST /api/v1/shutdown` | Graceful shutdown (responde 200 primeiro); montado apenas em binds de loopback |

#### `GET /api/v1/healthz`

Liveness probe para scripts e supervisores de processos. É o único endpoint `/api` isento do bearer token (veja [Autenticação](#autenticação)) e responde sem tocar na configuração ou na engine.

Em caso de sucesso, `data` é `{ "ok": true }`.

#### `GET /api/v1/meta`

Retorna a identidade desta instância e o mapa de capacidades. A maioria dos campos é congelada na inicialização; `experimental_flags` e `features` são resolvidos por requisição, de modo que a alteração de uma flag ou uma feature que falhou aparece na próxima resposta.

Em caso de sucesso, `data` carrega:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `server_version` | string | Versão do servidor |
| `capabilities` | object | Mapa de capacidades — `websocket`, `file_upload`, `fs_query`, `mcp`, `tasks`, `terminal`, todos sempre `true` |
| `server_id` | string | Id único desta instância do servidor |
| `started_at` | string | Tempo de inicialização, ISO 8601 |
| `open_in_apps` | array | Aplicativos do host utilizáveis como alvos `open-in` (`finder` / `cursor` / `vscode` / `iterm` / `terminal`); atualmente sempre vazio |
| `dangerous_bypass_auth` | boolean | Se o servidor foi iniciado com `--dangerous-bypass-auth` (clientes podem pular o prompt de token) |
| `backend` | string | Backend da engine, `v1` ou `v2`; sempre `v2` para este servidor |
| `web_title` | string | Título personalizado da aba do navegador a partir de `--web-title`; omitido quando não definido |
| `experimental_flags` | object | Id da flag experimental → habilitado, resolvido no momento da requisição |
| `features` | array | Features da engine como `{ name, state, meta }`; `state` é `Pending` / `Activating` / `Active` / `Unloading` / `Failed` |

#### `POST /api/v1/shutdown`

Solicita que o servidor seja desligado graciosamente. A resposta é enviada primeiro e o desligamento ocorre imediatamente depois, para que o chamador possa confiar na resposta que recebeu. A rota é montada apenas em binds de loopback — em um bind não-loopback ela sequer é registrada (as requisições resultam em um 404) a menos que o servidor tenha sido iniciado com `--allow-remote-shutdown`.

Em caso de sucesso, `data` é `{ "ok": true }`.

### Login e uso

Estes endpoints controlam o ciclo de vida do login OAuth gerenciado do Kimi e expõem informações em nível de conta. O provedor gerenciado é nomeado `managed:kimi-code`; o parâmetro opcional `provider` em todos os endpoints abaixo tem ele como padrão.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/auth` | Snapshot de autenticação |
| `POST /api/v1/oauth/login` | Inicia o fluxo de login de device-code do OAuth |
| `GET /api/v1/oauth/login` | Faz polling do estado do fluxo de login |
| `DELETE /api/v1/oauth/login` | Cancela um fluxo de login pendente |
| `POST /api/v1/oauth/logout` | Faz logout do provedor gerenciado |
| `GET /api/v1/oauth/usage` | Uso e limites do plano |
| `GET /api/v1/oauth/userinfo` | Perfil da conta |
| `GET /api/v1/oauth/region` | Resolve a região do cliente (`mainland-cn` / `global`) |

l` and models injected through `KIMI_MODEL_*` environment variables. It does not verify credentials, so a prompt can still fail afterwards with `40111` / `40112`.

On success, `data` carries `models_ready` (boolean), `providers_count` (number of configured providers), and `managed_provider` (`null`, or `{ name, status }` with `status` one of `authenticated` / `expired` / `revoked` / `unauthenticated`). The global default model alias itself is read from `GET /api/v1/config` (`default_model`), not from this endpoint.

#### `GET /api/v1/auth`

Snapshot de autenticação: se o modelo padrão resolve para uma configuração de provedor utilizável, além do estado de login do provedor gerenciado. `models_ready` é `true` quando o alias global `default_model` existe na tabela de modelos e resolve para um provedor configurado — incluindo modelos planos sem provedor (providerless flat models) que carregam sua própria `base_url` e modelos injetados através das variáveis de ambiente `KIMI_MODEL_*`. Ele não verifica credenciais, portanto um prompt ainda pode falhar posteriormente com `40111` / `40112`.

Em caso de sucesso, `data` carrega `models_ready` (booleano), `providers_count` (número de provedores configurados) e `managed_provider` (`null`, ou `{ name, status }` com `status` sendo um de `authenticated` / `expired` / `revoked` / `unauthenticated`). O próprio alias do modelo padrão global é lido de `GET /api/v1/config` (`default_model`), não deste endpoint.

#### `POST /api/v1/oauth/login`

Inicia um fluxo de login de device-code do OAuth para o provedor gerenciado; iniciar um novo fluxo aborta qualquer fluxo pendente para o mesmo provedor. Quando a conta já está autenticada, nenhuma interação do usuário é necessária e a resposta relata `authenticated` imediatamente.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider` | body | string | Nome do provedor gerenciado. Padrão `managed:kimi-code` |
| `region` | body | string | `mainland-cn` ou `global`; substitui a resolução de região descrita em `GET /api/v1/oauth/region` para este fluxo |

Em caso de sucesso, `data` tem um de dois formatos. Um fluxo pendente — `{ flow_id, provider, status: "pending", verification_uri, verification_uri_complete, user_code, expires_in, interval, expires_at }`: abra `verification_uri_complete` (ou `verification_uri` e insira o `user_code`), em seguida, faça polling de `GET /api/v1/oauth/login` a cada `interval` segundos até que o fluxo seja resolvido ou `expires_at` seja ultrapassado (`expires_in` é o mesmo prazo em segundos). O caminho rápido já autenticado — `{ flow_id, provider, status: "authenticated" }`.

#### `GET /api/v1/oauth/login`

Faz polling do estado do fluxo de login para um provedor. Retorna `null` quando nenhum fluxo foi iniciado.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider` | query | string | Nome do provedor gerenciado. Padrão `managed:kimi-code` |

Em caso de sucesso, `data` é `null` ou um snapshot do fluxo: `{ flow_id, provider, status, verification_uri, verification_uri_complete, user_code, expires_in, expires_at, interval }`, onde `status` é `pending` / `authenticated` / `denied` / `expired` / `cancelled`. Uma vez que o fluxo deixa o estado `pending`, `resolved_at` registra quando ele atingiu seu estado terminal e `error_message` descreve um fluxo que falhou.

#### `DELETE /api/v1/oauth/login`

Cancela o fluxo de login pendente para um provedor. Quando não há fluxo pendente, a chamada é um no-op que relata o último estado conhecido.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider` | query | string | Nome do provedor gerenciado. Padrão `managed:kimi-code` |

Em caso de sucesso, `data` é `{ cancelled, status }`: `cancelled` é `true` apenas quando um fluxo `pending` foi efetivamente abortado, e `status` é o estado do fluxo após a chamada.

#### `POST /api/v1/oauth/logout`

Faz logout do provedor gerenciado: descarta a credencial OAuth armazenada, aborta qualquer fluxo de login pendente e remove o provedor gerenciado da configuração. Provedores gerenciados via OAuth rejeitam edição e exclusão manuais (veja `PUT` / `DELETE /api/v1/providers/{provider_id}` abaixo), então faça logout primeiro para remover um.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider` | body | string | Nome do provedor gerenciado. Padrão `managed:kimi-code` |

Em caso de sucesso, `data` é `{ logged_out: true, provider }`.

#### `GET /api/v1/oauth/usage`

Uso e limites do plano da conta gerenciada, buscados em tempo real do serviço de contas. Uma falha de upstream não causa falha no envelope — ela retorna na mesma banda (in-band) com `kind: "error"`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider` | query | string | Nome do provedor gerenciado. Padrão `managed:kimi-code` |

Em caso de sucesso, `data` é `{ kind: "ok", summary, limits, extra_usage }` ou `{ kind: "error", message, status? }`, onde `status` é o status HTTP do upstream quando existe um. No formato `ok`, `summary` (anulável/nullable) é a linha de cota principal e `limits` lista todas as janelas de cota; uma linha é `{ name?, window?, used, limit, reset_at? }` com `window` sendo `{ duration, unit }`, `unit` um de `minute` / `hour` / `day` / `week`. `extra_usage` (anulável/nullable) é a carteira pay-as-you-go: `{ balance_cents, total_cents, monthly_charge_limit_enabled, monthly_charge_limit_cents, monthly_used_cents, currency }`.

#### `GET /api/v1/oauth/userinfo`

Perfil da conta gerenciada, com a mesma convenção in-band `kind: "error"` de `GET /api/v1/oauth/usage`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider` | query | string | Nome do provedor gerenciado. Padrão `managed:kimi-code` |

Em caso de sucesso, `data` é `{ kind: "ok", userInfo }` ou `{ kind: "error", message, status? }`. `userInfo` carrega sempre `userId`, `nickname`, `status`, `region`, `userLevel`, `userLevelName`, `domain`, e `domainName`, e pode adicionar `globalId`, `bio`, `avatar`, `username`, `email`, `phone` (`{ countryCode, number }`), `createdTime`, e `lastLoginTime`.

#### `GET /api/v1/oauth/region`

Resolve a qual região Kimi este cliente pertence. A resposta é derivada localmente, não sondada pela rede: um host OAuth fixado pelo ambiente ou pela configuração prevalece primeiro, em seguida a chave OAuth configurada, depois o arquivo marcador de região no diretório home; o padrão é `mainland-cn`.

Em caso de sucesso, `data` é `{ region }` com `region` sendo uma de `mainland-cn` / `global`.

### Configuração

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/config` | Ler a configuração global (campos sensíveis omitidos) |
| `POST /api/v1/config` | Fazer merge-patch da configuração; transmite `event.config.changed` |

#### `GET /api/v1/config`

Retorna a configuração global resolvida — o resultado efetivo de `config.toml` mais sobreposições. Segredos são omitidos (redacted): cada provedor relata apenas `has_api_key`, nunca a chave armazenada.

Em caso de sucesso, `data` é o objeto de configuração; seus campos espelham os domínios de nível superior documentados em [Campos de nível superior](../configuration/config-files.md#top-level-fields):

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `providers` | object | Mapa de id do provedor → `{ type, base_url?, default_model?, has_api_key }` |
| `default_provider` | string | Id do provedor padrão global |
| `default_model` | string | Alias do modelo padrão global |
| `models` | object | Mapa de alias de modelo → registro de modelo |
| `thinking` | object | Parâmetros padrão para o modo Thinking |
| `plan_mode` | boolean | Flag do modo Plan |
| `yolo` | boolean | Derivado: `true` quando `default_permission_mode` é `yolo` |
| `default_permission_mode` | string | Modo de permissão padrão para novas sessões |
| `default_plan_mode` | boolean | Se novas sessões iniciam no modo Plan |
| `permission` | object | Regras iniciais de permissão |
| `hooks` | array | Hooks de ciclo de vida |
| `services` | object | Configuração de serviço externo embutido |
| `merge_all_available_skills` | boolean | Se deve mesclar Agent Skills de todos os diretórios disponíveis |
| `extra_skill_dirs` | array | Diretórios extras de busca de skills |
| `loop_control` | object | Parâmetros de controle de loop do agente |
| `background` | object | Parâmetros de runtime de tarefas em background |
| `subagent` | object | Configuração de subagente |
| `secondary_model` | object | Pool de modelos secundários para subagentes |
| `experimental` | object | Id de flag experimental → habilitado |
| `telemetry` | boolean | Se a telemetria anônima está habilitada |
| `raw` | object | Conteúdo bruto analisado de `config.toml`, campos não modelados incluídos |

#### `POST /api/v1/config`

Faz merge-patch da configuração global: cada domínio de nível superior no corpo sofre um deep-merge nesse domínio, e os domínios ausentes no corpo são deixados intactos. Definir `yolo` como `true` é um atalho para `default_permission_mode: "yolo"`; um patch rejeitado (valor inválido ou falha de persistência) retorna `40001` com a mensagem subjacente.

Toda mudança de configuração — uma atualização bem-sucedida através deste endpoint, uma edição externa do `config.toml`, ou uma gravação no lado do servidor como uma atualização de login OAuth — é transmitida como o evento global `event.config.changed`. Mudanças dentro de uma janela curta são mescladas em um único evento carregando os nomes dos domínios afetados em `changedFields` (domínios de configuração em camelCase, por exemplo `defaultModel`) e a projeção completa da configuração atual em `config` (mesmo formato da resposta de `GET /api/v1/config`).

O corpo é um objeto de configuração parcial — qualquer subconjunto dos domínios de resposta acima exceto `raw`, todos opcionais:

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `providers` | body | object | Mapa de id do provedor → tabela do provedor |
| `default_provider` | body | string | Id do provedor padrão global |
| `default_model` | body | string | Alias do modelo padrão global |
| `models` | body | object | Mapa de alias de modelo → registro de modelo |
| `thinking` | body | object | Parâmetros padrão para o modo Thinking |
| `plan_mode` | body | boolean | Flag do modo Plan |
| `yolo` | body | boolean | `true` mapeia para `default_permission_mode: "yolo"`; `false` é ignorado |
| `default_permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `default_plan_mode` | body | boolean | Se novas sessões iniciam no modo Plan |
| `permission` | body | object | Regras iniciais de permissão |
| `hooks` | body | array | Hooks de ciclo de vida |
| `services` | body | object | Configuração de serviço externo embutido |
| `merge_all_available_skills` | body | boolean | Se deve mesclar Agent Skills de todos os diretórios disponíveis |
| `extra_skill_dirs` | body | array | Diretórios extras de busca de skills |
| `loop_control` | body | object | Parâmetros de controle de loop do agente |
| `background` | body | object | Parâmetros de runtime de tarefas em background |
| `subagent` | body | object | Configuração de subagente |
| `secondary_model` | body | object | Pool de modelos secundários para subagentes |
| `experimental` | body | object | Id de flag experimental → habilitado |
| `telemetry` | body | boolean | Se a telemetria anônima está habilitada |

Em caso de sucesso, `data` é a configuração completa atualizada no mesmo formato de `GET /api/v1/config`.

### Modelos e provedores

Estes endpoints gerenciam as duas metades da configuração de modelos — a tabela de [provedores](../configuration/providers.md) e a tabela de aliases de modelos do `config.toml` — além de um diretório models.dev providenciado pelo servidor (server-proxied) para importações de disparo único (one-shot). Um id de alias de modelo é a chave de alias exata configurada: aliases criados através dos endpoints de gerenciamento de provedores assumem a forma `provider_id/model` (por exemplo, `my-provider/kimi-for-coding`), enquanto uma chave simples (bare key) da tabela de modelos como `turbo` é usada como está; onde quer que a API receba um `model_id`, incluindo o `default_model` global, isso significa este id de alias. Uma ação não suportada em uma rota `:{action}` retorna `40001`.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/models` | Listar aliases de modelos configurados |
| `POST /api/v1/models/{model_id}:set_default` | Definir o modelo padrão global |
| `GET /api/v1/providers` | Listar provedores |
| `POST /api/v1/providers` | Criar um provedor (201) |
| `GET /api/v1/providers/{provider_id}` | Ler um provedor (revela a chave armazenada) |
| `PUT /api/v1/providers/{provider_id}` | Substituir um provedor |
| `DELETE /api/v1/providers/{provider_id}` | Excluir um provedor (204) |
| `POST /api/v1/providers/{provider_id}:refresh` | Atualizar os metadados de modelo de um provedor |
| `POST /api/v1/providers:{action}` | Ações de coleção: `refresh` / `refresh_oauth` / `import_catalog` / `import_registry` |
| `GET /api/v1/catalog/providers` | Navegar no diretório models.dev (server-proxied) |
| `GET /api/v1/catalog/providers/{catalog_id}` | Ler uma entrada do diretório |

#### `GET /api/v1/models`

Lista todos os aliases de modelos configurados em todos os provedores.

Em caso de sucesso, `data.items` é um array de `{ provider, model, display_name?, max_context_size, capabilities?, support_efforts?, default_effort? }`: `model` é o id do alias (`provider_id/model` para aliases gerenciados por provedor, caso contrário, a chave simples), `provider` o id do provedor proprietário, `max_context_size` a janela de contexto em tokens, e `capabilities` / `support_efforts` / `default_effort` descrevem flags de capacidade e suporte de esforço no modo Thinking.

#### `POST /api/v1/models/{model_id}:set_default`

Define o `default_model` global para um alias existente. `model_id` é a chave exata do alias configurado — para uma chave simples como `turbo` a chamada é `POST /api/v1/models/turbo:set_default`; codifique o id na URL (URL-encode) quando ele contiver `/`, como em `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `model_id` | path | string | **Obrigatório.** A chave exata do alias de modelo configurado; faça o URL-encode quando contiver `/` |

Em caso de sucesso, `data` é `{ default_model, model }` — o alias em vigor agora e seu item de catálogo (mesmo formato que um item de `GET /api/v1/models`).

- `40001`: sufixo de ação malformado ou não suportado no caminho
- `40413`: nenhum alias de modelo com esse id

#### `GET /api/v1/providers`

Lista todos os provedores configurados com sua credencial e estado de descoberta de modelos, sem revelar nenhuma chave. Este é o formato de item de provedor referenciado pelos outros endpoints de provedor.

Em caso de sucesso, `data.items` é um array de:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `id` | string | Id do provedor |
| `type` | string | Protocolo de transporte (wire protocol): `kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `base_url` | string | URL base da API, quando definida |
| `default_model` | string | Alias de modelo padrão do provedor, quando definido |
| `has_api_key` | boolean | Se uma credencial está armazenada |
| `status` | string | `connected` quando uma chave de API ou token OAuth em cache existe, `unconfigured` caso contrário (`error` é reservado no esquema) |
| `models` | array | Ids de alias de modelo do provedor |

#### `POST /api/v1/providers`

Cria um provedor e seus aliases de modelo em um único salvamento (save); a resposta é HTTP 201 com o envelope padrão. Quando nenhum `default_model` global está configurado (instalação nova), ele é preenchido com o `default_model` do novo provedor (ou o primeiro modelo); um padrão existente nunca é modificado.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `id` | body | string | **Obrigatório.** Id do provedor — letras, dígitos, `-`, `_` e espaços; deve começar com uma letra ou dígito |
| `type` | body | string | **Obrigatório.** Protocolo de transporte (wire protocol): `kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `api_key` | body | string | Chave da API, armazenada em `config.toml` |
| `base_url` | body | string | URL base da API; não deve conter um marcador de variável de ambiente (`${...}`) |
| `default_model` | body | string | O modelo padrão do provedor; deve ser um de `models[].model` |
| `models` | body | array | **Obrigatório.** Pelo menos uma entrada, sem valores `model` duplicados; formato da entrada abaixo |

Cada entrada `models[]` declara um alias cujo id se torna `id/model`:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `model` | string | **Obrigatório.** Nome do modelo no upstream |
| `max_context_size` | integer | **Obrigatório.** Janela de contexto em tokens, ≥ 1 |
| `display_name` | string | Nome de exibição |
| `capabilities` | array | Flags de capacidade, como `thinking` ou `image_in` |
| `max_output_size` | integer | Máximo de tokens de saída, ≥ 1 |
| `support_efforts` | array | Níveis de esforço suportados no modo Thinking |
| `adaptive_thinking` | boolean | Alternador (toggle) de pensamento adaptativo |

Em caso de sucesso, `data` é o item de provedor criado (mesmo formato que um item de `GET /api/v1/providers`).

- `40921`: já existe um provedor com este `id`

#### `GET /api/v1/providers/{provider_id}`

Lê um provedor. Ao contrário da rota de lista, a resposta revela a `api_key` armazenada quando uma está definida, para que um formulário de edição local possa ser pré-preenchido — tenha isso em mente ao expor a porta.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Obrigatório.** Id do provedor |

Em caso de sucesso, `data` é o item do provedor mais a `api_key` quando uma chave está armazenada.

- `40412`: provedor não encontrado

#### `PUT /api/v1/providers/{provider_id}`

Substitui um provedor em um único salvamento: `type`, `base_url` e a lista de modelos são reescritos, e os aliases do provedor são reconstruídos a partir de `models` — aliases que não constam mais na lista desaparecem de `config.toml`, enquanto os aliases de outros provedores permanecem intactos. `api_key` é um estado triplo (tri-state): omitido mantém a chave armazenada, `""` a apaga, qualquer outro valor a substitui. Além da migração de renomeação de `new_id`, os ponteiros padrão globais nunca são modificados.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Obrigatório.** Id atual do provedor |
| `new_id` | body | string | Renomeia o provedor; a chave provedores, aliases de modelo, `default_provider`, um `default_model` apontando para um alias antigo e o pool de modelos secundários do subagente migram todos. Mesmas regras de id que `POST /api/v1/providers` |
| `type` | body | string | **Obrigatório.** Protocolo de transporte (wire protocol): `kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `api_key` | body | string | Estado triplo (tri-state), veja acima |
| `base_url` | body | string | URL base da API; não deve conter um marcador de variável de ambiente (`${...}`) |
| `default_model` | body | string | O modelo padrão do provedor; deve ser um de `models[].model` |
| `models` | body | array | **Obrigatório.** Pelo menos uma entrada, sem valores `model` duplicados; mesmo formato de entrada de `POST /api/v1/providers` |

Em caso de sucesso, `data` é `{ provider }` com o item do provedor salvo.

- `40001`: um id de alias renomeado colidiria com o alias de outro provedor
- `40003`: o provedor é gerenciado via OAuth — faça logout via `POST /api/v1/oauth/logout` em seu lugar
- `40412`: provedor não encontrado
- `40921`: `new_id` já está em uso

#### `DELETE /api/v1/providers/{provider_id}`

Exclui um provedor e todos os seus aliases de modelo; o pool de modelos secundários do subagente é excluído em cascata. Os ponteiros globais `default_provider` / `default_model` permanecem intactos, mesmo quando apontam para o provedor excluído — eles são configurações do usuário e não cabem a este endpoint fazer a coleta de lixo (garbage-collect).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Obrigatório.** Id do provedor |

Em caso de sucesso, o servidor responde 204 sem corpo — a própria linha de status relata a exclusão (veja [Envelope de resposta](#envelope-de-resposta)).

- `40003`: o provedor é gerenciado via OAuth — faça logout via `POST /api/v1/oauth/logout` em seu lugar
- `40412`: provedor não encontrado

#### `POST /api/v1/providers/{provider_id}:refresh`

Redescobre os metadados de modelo de um provedor a partir de sua fonte upstream e reescreve os aliases do provedor. Provedores com uma fonte de modelo estática são relatados como `unchanged` (inalterados) sem nenhuma chamada de rede. Quando os aliases de pelo menos um provedor mudam, o servidor transmite o evento global `event.model_catalog.changed`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Obrigatório.** Id do provedor |

Em caso de sucesso, `data` é um relatório de atualização: `changed` é um array de `{ provider_id, provider_name, added, removed }` (contagens de aliases adicionados/removidos), `unchanged` é um array de ids de provedores sem diferenças e `failed` é um array de `{ provider, reason }`.

- `40001`: sufixo de ação malformado ou não suportado no caminho
- `40412`: provedor não encontrado

#### `POST /api/v1/providers:refresh`

Atualiza os metadados de modelo para todos os provedores. O corpo é opcional e ignorado.

Em caso de sucesso, `data` é o mesmo relatório de atualização de `POST /api/v1/providers/{provider_id}:refresh` (`changed` / `unchanged` / `failed`).

#### `POST /api/v1/providers:refresh_oauth`

A mesma atualização de `POST /api/v1/providers:refresh`, limitada a provedores suportados por OAuth. O corpo é opcional e ignorado.

Em caso de sucesso, `data` é o relatório de atualização (`changed` / `unchanged` / `failed`).

#### `POST /api/v1/providers:import_catalog`

Importa uma entrada do diretório models.dev como um provedor configurado; a resposta é HTTP 201 com o envelope padrão. O protocolo de transporte e o endpoint vêm da resolução do catálogo, e cada modelo catalogado é escrito como um alias. Importar um id que já existe é uma atualização — a entrada do provedor e seus aliases são reescritos do catálogo, e uma `api_key` omitida mantém a chave armazenada. Os ponteiros padrão globais nunca são modificados, exceto que o `default_model` é preenchido a partir do primeiro modelo importado quando nenhum está configurado no momento.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `catalog_id` | body | string | **Obrigatório.** Id da entrada de diretório a partir de `GET /api/v1/catalog/providers` |
| `id` | body | string | Substitui o id do catálogo como o id do provedor local. Mesmas regras de id que `POST /api/v1/providers` |
| `api_key` | body | string | Chave de API para o provedor importado |
| `base_url` | body | string | Substitui o endpoint resolvido pelo catálogo; obrigatório quando `needs_base_url` da entrada for `true` |

Em caso de sucesso, `data` é `{ provider, models_imported }` — o item do provedor e o número de aliases escritos.

- `40001`: `catalog_id` faltando ou outra falha de validação do corpo
- `40003`: o provedor alvo existe e é gerenciado via OAuth
- `40004`: a entrada não pode ser importada (rejeitada, requer uma `base_url`, não tem modelos importáveis, ou seu id é inutilizável como um id de provedor)
- `40417`: nenhuma entrada de diretório com esse `catalog_id`
- `50004`: o diretório models.dev está indisponível

#### `POST /api/v1/providers:import_registry`

Importa um registro privado no formato models.dev — uma URL `api.json` mais uma chave Bearer opcional — como provedores configurados; a resposta é HTTP 201 com o envelope padrão. Cada provedor listado é gravado com um registro `source` para que atualizações programadas o redescubram. Reimportar a mesma URL remove os provedores que desapareceram no upstream — a URL é a identidade estável do registro, então rotacionar a chave é seguro. Os ponteiros padrão globais seguem as mesmas regras de `:import_catalog`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `url` | body | string | **Obrigatório.** URL do `api.json` do registro |
| `api_key` | body | string | Chave Bearer para o registro; quando omitida, a chave da importação anterior da mesma URL é reutilizada |

Em caso de sucesso, `data` é `{ providers, models_imported }` — um array de itens de provedor e o número total de aliases escritos.

- `40001`: `url` faltando ou outra falha de validação do corpo
- `40003`: um provedor listado existe e é gerenciado via OAuth
- `40005`: o registro não pode ser buscado ou analisado, ou não lista provedores importáveis

#### `GET /api/v1/catalog/providers`

Navega no diretório models.dev, com proxy feito pelo servidor com um cache em memória de 10 minutos e um fallback de snapshot embutido. Os itens mantêm a ordem do diretório upstream. Entradas que o servidor não pode importar carregam `rejected: true` com um `reject_reason` legível por máquina; entradas com `needs_base_url: true` exigem uma URL base no momento da importação.

Em caso de sucesso, `data.items` é um array de `{ id, name, wire_type, guessed, needs_base_url, rejected, reject_reason, env_key, models }`: `wire_type` é o protocolo resolvido (nullable, mesmo enum que o `type` de um provedor), `guessed` marca uma resolução heurística, `env_key` é a variável de ambiente convencional da chave de API do upstream (nullable), e `models` é um array de `{ id, name?, max_context_size, capabilities?, reasoning }`.

- `50004`: o diretório está indisponível (tanto a busca ao vivo quanto o snapshot embutido falharam)

#### `GET /api/v1/catalog/providers/{catalog_id}`

Lê uma entrada do diretório models.dev pelo id do catálogo — o mesmo formato de item de `GET /api/v1/catalog/providers`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `catalog_id` | path | string | **Obrigatório.** Id da entrada de diretório |

Em caso de sucesso, `data` é a entrada de diretório (mesmo formato que um item de `GET /api/v1/catalog/providers`).

- `40417`: nenhuma entrada de diretório com esse `catalog_id`
- `50004`: o diretório está indisponível

### Sessões

Estes endpoints criam, listam e inspecionam sessões, conduzem ações no nível da sessão (fork, compact, undo, entre outras) e leem sumarizações (rollups) por sessão. A maioria deles retorna uma sessão no formato de transporte (wire shape) documentado uma vez em [O objeto de sessão](#o-objeto-de-sessão); operações não-CRUD usam a convenção `:{action}` descrita acima.

| Método e caminho | Descrição |
| --- | --- |
| `POST /api/v1/sessions` | Criar uma sessão (requer `workspace_id` ou `metadata.cwd`) |
| `GET /api/v1/sessions` | Listar sessões; paginação por cursor com filtros como `busy` e `archived_only` |
| `GET /api/v1/sessions/{session_id}` | Ler uma sessão |
| `GET /api/v1/sessions/{session_id}/profile` | Ler o perfil da sessão |
| `POST /api/v1/sessions/{session_id}/profile` | Atualizar título, metadados, configuração do agente |
| `POST /api/v1/sessions/{session_id}/title/generate` | Gerar um título via ferramenta gerenciada `chat_title` |
| `POST /api/v1/sessions/{session_id}:{action}` | Ações de sessão: `fork` / `compact` / `undo` / `abort` / `btw` / `archive` / `restore` |
| `GET /api/v1/sessions/{session_id}/children` | Listar sessões filhas |
| `POST /api/v1/sessions/{session_id}/children` | Criar uma sessão filha (fork com uma tag) |
| `GET /api/v1/sessions/{session_id}/status` | Sumarização (rollup) de status em tempo real |
| `GET /api/v1/sessions/{session_id}/goal` | Snapshot do objetivo atual (`null` quando nenhum) |
| `GET /api/v1/sessions/{session_id}/warnings` | Avisos no nível da sessão |
| `GET /api/v1/sessions/{session_id}/runtime` | Ler a ligação de runtime (runtime binding) do agente principal |
| `POST /api/v1/sessions/{session_id}/runtime` | Trocar a ligação de runtime do agente principal |
| `POST /api/v1/sessions/{session_id}/export` | Exportar a sessão com diagnósticos (stream zip, não envelopado) |
| `GET /api/v1/sessions/{session_id}/snapshot` | Snapshot completo para reconstruções do cliente (com `as_of_seq` e `epoch`) |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | Baixar mídia do prompt por id de arquivo (binário) |

#### O objeto da sessão

Todo endpoint que retorna uma sessão usa este formato de transporte (wire shape). Os fatos em tempo real (`busy`, `main_turn_active`, `pending_interaction`, `last_turn_reason`) são resolvidos a partir do agregado de atividades da sessão: uma sessão que não está carregada neste processo do servidor (uma sessão fria) sempre relata não estar ocupada (not-busy) com nenhuma interação pendente. Alguns campos são marcadores (placeholders) na projeção atual — isso é notado em cada campo.

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `id` | string | Id da sessão (`session_...`) |
| `workspace_id` | string | Id do workspace proprietário |
| `title` | string | Título da sessão; `""` quando sem título |
| `created_at` / `updated_at` | string | Tempos de criação e última atualização, ISO 8601 |
| `archived` | boolean | Se a sessão está arquivada (oculta da lista de sessões padrão) |
| `archived_at` | string | Tempo de arquivamento, ISO 8601; presente apenas quando arquivada |
| `busy` | boolean | Algum agente possui um turno ou tarefa em background ativo |
| `main_turn_active` | boolean | O agente principal possui um turno ativo |
| `pending_interaction` | string | `none` / `approval` / `question` — uma interação não respondida está aguardando |
| `last_turn_reason` | string | Resultado do último turno do agente principal: `completed` / `cancelled` / `failed` |
| `last_prompt` | string | Texto do prompt de usuário mais recente, quando presente |
| `metadata` | object | Metadados personalizados; carrega sempre `cwd` (o diretório de trabalho da sessão) |
| `agent_config` | object | Projetado como `{ model }`; `model` é `""` na maioria das respostas e só é preenchido com o modelo em uso por `GET /api/v1/sessions/{session_id}/snapshot` |
| `usage` | object | Sumarização (rollup) de tokens `{ input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context_tokens, context_limit?, total_cost_usd?, turn_count? }`; todos zeros fora do endpoint de snapshot |
| `permission_rules` | array | Regras de permissão da sessão; atualmente sempre `[]` |
| `message_count` | integer | Contagem de mensagens; atualmente sempre `0` |
| `last_seq` | integer | Último número de sequência de evento; atualmente sempre `0` |

#### `POST /api/v1/sessions`

Cria uma sessão e a retorna. O diretório alvo vem de `workspace_id` (um workspace já registrado) ou de `metadata.cwd` (o workspace é registrado no primeiro uso); passar ambos requer que eles correspondam. A criação transmite o evento global `event.session.created`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | body | string | **Obrigatório** quando `metadata.cwd` está ausente. Id de workspace registrado; a sessão é criada na raiz desse workspace |
| `metadata` | body | object | Metadados personalizados. `metadata.cwd` é o diretório de trabalho e é **obrigatório** quando `workspace_id` está ausente; se ambos forem fornecidos, ele deve ser igual à raiz do workspace |
| `title` | body | string | Título inicial (pelo menos 1 caractere); caso contrário a sessão fica sem título |
| `agent_config` | body | object | Aceito pelo schema mas atualmente não aplicado — defina o modelo e os modos através de `POST /api/v1/sessions/{session_id}/profile` |

Em caso de sucesso, `data` é [o objeto de sessão](#o-objeto-de-sessão) da nova sessão.

- `40001`: nem `workspace_id` nem `metadata.cwd` fornecidos, ou `metadata.cwd` não corresponde à raiz do workspace (`details` lista o campo)
- `40409`: o diretório de trabalho não existe ou não é um diretório
- `40410`: nenhum workspace registrado com esse `workspace_id`

#### `GET /api/v1/sessions`

Lista sessões de todos os workspaces, as mais recentes por `updated_at` primeiro. A paginação por cursor segue a [Paginação](#paginação), com uma particularidade: sem `page_size` (e sem `archived_only`) a resposta é uma única janela não paginada onde `has_more` é sempre `false`, então passe `page_size` para efetivamente paginar.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `before_id` | query | string | Apenas sessões mais antigas que este id; mutuamente exclusivo com `after_id` |
| `after_id` | query | string | Apenas sessões mais novas que este id; mutuamente exclusivo com `before_id` |
| `page_size` | query | integer | 1–100. Quando a paginação se aplica, o padrão é `20`; veja a nota acima para o comportamento padrão não paginado |
| `busy` | query | boolean | Manter apenas sessões ocupadas (ou apenas ociosas) |
| `include_archive` | query | boolean | Incluir sessões arquivadas junto com as ativas. Padrão `false` |
| `archived_only` | query | boolean | Manter apenas sessões arquivadas; mutuamente exclusivo com `include_archive`; implica paginação por cursor mesmo sem `page_size` |
| `exclude_empty` | query | boolean | Descartar sessões que não contêm nenhum prompt de usuário |
| `workspace_id` | query | string | Restringir a um workspace (aliases são resolvidos) |

Em caso de sucesso, `data` é `{ items, has_more }` onde cada item é [o objeto de sessão](#o-objeto-de-sessão).

- `40001`: falha de validação — por exemplo, `before_id` combinado com `after_id`, ou `archived_only` combinado com `include_archive`
- `40410`: `workspace_id` desconhecido

#### `GET /api/v1/sessions/{session_id}`

Lê uma sessão a partir do índice. Fatos em tempo real (live facts) são incluídos quando a sessão está carregada neste processo; uma sessão fria (cold session) relata não estar ocupada (not-busy) com o resultado do seu último turno persistido.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é [o objeto de sessão](#o-objeto-de-sessão).

- `40401`: sessão não encontrada, ou seu workspace não pode mais ser resolvido

#### `GET /api/v1/sessions/{session_id}/profile`

Lê o perfil da sessão — o mesmo payload de transporte (wire payload) de `GET /api/v1/sessions/{session_id}`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é [o objeto de sessão](#o-objeto-de-sessão).

- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/profile`

Atualiza o perfil da sessão: título, metadados personalizados e a configuração do agente principal. Um título definido aqui se torna um título personalizado, que tem prioridade sobre títulos gerados; definir um transmite o evento global `session.meta.updated`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `title` | body | string | Novo título (pelo menos 1 caractere); torna-se um título personalizado |
| `metadata` | body | object | Chaves mescladas nos metadados personalizados da sessão |
| `agent_config` | body | object | Configuração parcial do agente principal; campos abaixo, todos opcionais |

Cada campo de `agent_config` é aplicado imediatamente ao agente principal:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `model` | string | Id do alias do modelo; uma string vazia é ignorada |
| `thinking` | string | Nível de esforço do modo Thinking |
| `permission_mode` | string | `manual` / `yolo` / `auto` |
| `plan_mode` | boolean | Entrar ou sair do modo Plan |
| `swarm_mode` | boolean | Entrar ou sair do modo swarm |
| `goal_objective` | string | Criar um objetivo (goal) com este propósito (objective) |
| `goal_control` | string | `pause` / `resume` / `cancel` do objetivo atual |

O schema também aceita `system_prompt`, `tools`, `mcp_servers` dentro de `agent_config`, e um array `permission_rules` no nível superior, mas a rota de atualização atualmente não os aplica.

Em caso de sucesso, `data` é o [objeto de sessão](#o-objeto-de-sessão) atualizado.

- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/title/generate`

Gera um título a partir dos prompts da sessão por meio da ferramenta `chat_title` do provedor gerenciado e o aplica, transmitindo `session.meta.updated`. A geração requer o login OAuth gerenciado e a flag experimental `auto_session_title`; sem `force`, uma sessão que já possui um título personalizado ou gerado é relatada como indisponível em vez de ser sobrescrita.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `force` | body | boolean | Regenerar mesmo quando um título personalizado ou gerado existir. Padrão `false` |
| `source` | body | string | Entrada do título: `user_prompts` (padrão) / `first_turn` / `digest` |

Em caso de sucesso, `data` é `{ title }` — o título agora aplicado à sessão.

- `40401`: sessão não encontrada
- `40923`: geração indisponível — a flag está desligada, não há login OAuth gerenciado ou ainda não há conteúdo de prompt, um título existente sem `force`, ou a requisição ao backend falhou

#### `POST /api/v1/sessions/{session_id}:{action}`

As ações de sessão são despachadas por meio de uma única rota: a parte final do caminho (path tail) é analisada como `{session_id}:{action}`, o corpo é validado contra o schema da ação, e uma ação ausente ou desconhecida falha com `40001` (`unsupported action: ...`). Toda ação resolve a sessão primeiro, de modo que todas elas podem retornar `40401` para uma sessão desconhecida. As ações suportadas estão documentadas uma a uma abaixo.

#### `POST /api/v1/sessions/{session_id}:fork`

Copia a sessão — sua transcrição, estado do agente e arquivos — para uma nova sessão no mesmo workspace, e transmite `event.session.created`. O fork é rejeitado enquanto qualquer um dos agentes da sessão tiver um turno ativo.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `title` | body | string | Título para o fork (pelo menos 1 caractere). Padrão `Fork: <source title>` |
| `metadata` | body | object | Metadados personalizados para o fork |

Em caso de sucesso, `data` é [o objeto de sessão](#o-objeto-de-sessão) da nova sessão.

- `40901`: a sessão tem um turno ativo e não pode sofrer fork

#### `POST /api/v1/sessions/{session_id}:compact`

Inicia uma compactação completa manual do contexto do agente principal. A chamada retorna imediatamente; o progresso e a conclusão são entregues como os eventos WebSocket `compaction.*`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `instruction` | body | string | Orientação extra para o resumo da compactação; um valor em branco é ignorado |

Em caso de sucesso, `data` é um objeto vazio.

- `40910`: um turno ou outra mudança de contexto está ativo(a), ou o histórico não tem nada para compactar

#### `POST /api/v1/sessions/{session_id}:undo`

Retrocede a conversa do agente principal em `count` turnos e reconcilia o estado derivado da sessão (incluindo o `last_prompt` da sessão).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `count` | body | integer | Número de turnos para desfazer; inteiro positivo. Padrão `1` |
| `page_size` | body | integer | Tamanho da janela de histórico retornada, 1–100. Padrão `50` |

Em caso de sucesso, `data` é `{ messages, status }`: `messages` é uma página `{ items, has_more }` das mensagens de contexto restantes, as mais novas primeiro, e `status` é a mesma sumarização (rollup) de `GET /api/v1/sessions/{session_id}/status`.

- `40901`: um turno está ativo ou uma compactação está em execução — espere terminar e tente novamente
- `40911`: essa quantidade de turnos não pode ser desfeita (um limite de compactação ou checkpoints perdidos); `data` carrega `{ reason, requestedCount, undoableCount }`

#### `POST /api/v1/sessions/{session_id}:abort`

Cancela o turno em execução do agente principal — o equivalente programático ao usuário abortando o turno na TUI.

Em caso de sucesso, `data` é `{ aborted: true }`.

#### `POST /api/v1/sessions/{session_id}:btw`

Inicia uma conversa paralela "by the way" (a propósito): faz um fork do agente principal em um agente filho cujas chamadas de ferramenta estão desabilitadas, de modo que perguntas rápidas e paralelas rodem em isolamento sem tocar no contexto de trabalho. Requer uma configuração de modelo utilizável.

Em caso de sucesso, `data` é `{ agent_id }` — o id do novo agente filho.

#### `POST /api/v1/sessions/{session_id}:archive`

Marca a sessão como arquivada: ela desaparece da lista de sessões padrão (permanece listada com `include_archive` ou `archived_only`), e o servidor transmite o evento global `event.session.archived`.

Em caso de sucesso, `data` é `{ archived: true }`.

#### `POST /api/v1/sessions/{session_id}:restore`

Desarquiva a sessão e a retoma.

Em caso de sucesso, `data` é [o objeto de sessão](#o-objeto-de-sessão) com `archived: false`.

#### `GET /api/v1/sessions/{session_id}/children`

Lista as filhas da sessão — as sessões criadas através de `POST /api/v1/sessions/{session_id}/children`. A paginação por cursor segue a [Paginação](#paginação).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `before_id` | query | string | Apenas filhas mais antigas que este id; mutuamente exclusivo com `after_id` |
| `after_id` | query | string | Apenas filhas mais novas que este id; mutuamente exclusivo com `before_id` |
| `page_size` | query | integer | 1–100. Padrão `100` |
| `busy` | query | boolean | Manter apenas filhas ocupadas (ou apenas ociosas) |

Em caso de sucesso, `data` é `{ items, has_more }` onde cada item é [o objeto de sessão](#o-objeto-de-sessão).

- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/children`

Cria uma sessão filha: um fork desta sessão gravado como sua filha, para que apareça em `GET /api/v1/sessions/{session_id}/children`. A mesma restrição de turno ativo de `:fork` se aplica.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `title` | body | string | Título para a filha (pelo menos 1 caractere). Padrão `Child: <source title>` |
| `metadata` | body | object | Metadados personalizados para a filha |

Em caso de sucesso, `data` é [o objeto de sessão](#o-objeto-de-sessão) da nova sessão, e o servidor transmite `event.session.created`.

- `40901`: a sessão tem um turno ativo e não pode sofrer fork

#### `GET /api/v1/sessions/{session_id}/status`

Sumarização (rollup) de status em tempo real do agente principal; lê-la retoma a sessão se ela estiver fria (cold).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é `{ busy, model?, thinking_level, permission, plan_mode, swarm_mode, context_tokens, max_context_tokens?, context_usage? }`: `busy` relata um turno ativo, `model` / `thinking_level` / `permission` são as configurações efetivas do agente, `plan_mode` / `swarm_mode` são as flags de modo, e `context_tokens` com `max_context_tokens` e `context_usage` (0–1) descrevem o consumo da janela de contexto.

- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/goal`

Lê o snapshot do objetivo (goal) atual da sessão, ou `null` quando nenhum objetivo está ativo. Observe que este payload usa chaves em camelCase, ao contrário da maior parte desta API.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é `null` ou `{ goalId, objective, completionCriterion?, status, turnsUsed, tokensUsed, wallClockMs, budget, terminalReason? }`, onde `status` é `active` / `paused` / `blocked` / `complete` e `budget` relata os orçamentos (budgets) de token, turno e tempo de relógio (wall-clock) junto com as quantias restantes e as flags de atingimento por orçamento (cada uma anulável/nullable quando tal orçamento não está definido).

- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/warnings`

Lê os avisos (warnings) no nível da sessão. O produtor atual é a verificação de `AGENTS.md` sobredimensionado (`agents-md-oversized`), então a lista está vazia para a maioria das sessões.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é `{ warnings }`, cada entrada `{ code, message, severity }` com `severity` sendo um de `info` / `warning` / `error`.

- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/runtime`

Lê a ligação de runtime (runtime binding) do agente principal

#### `POST /api/v1/sessions/{session_id}/runtime`

#### `POST /api/v1/sessions/{session_id}/runtime`

Troca a ligação de runtime (runtime binding) do agente principal.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `runtime_id` | body | string | **Obrigatório.** Id do runtime alvo |

Em caso de sucesso, `data` é a nova ligação `{ workspace_id, runtime_id }`.

- `40420`: nenhum runtime com esse `runtime_id`
- `40926`: o runtime existe, mas está indisponível

#### `POST /api/v1/sessions/{session_id}/export`

Exporta a sessão junto com logs de diagnóstico como um anexo zip (`kimi-session-<id>.zip`). A resposta é um stream binário, não um envelope JSON — as semânticas de capacidades e falhas são cobertas em [Endpoints binários e de streaming](#endpoints-binários-e-de-streaming).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `web_log` | body | string | Texto do log do cliente para incluir no arquivo, no máximo 256 KB UTF-8 |
| `desktop` | body | boolean | Incluir também o log do host de desktop. Padrão `false` |

#### `GET /api/v1/sessions/{session_id}/snapshot`

Monta um snapshot atômico para reconstruir um cliente após um resync: a sessão, mensagens recentes, o turno em andamento (in-flight), subagentes em tempo real e interações pendentes, todos carimbados com a marca d'água `as_of_seq` e a `epoch` usada para reassinar — veja [Reconexão e recuperação](#reconexão-e-recuperação). Ao contrário dos endpoints de sessão simples, a sessão embutida carrega o `agent_config.model` em tempo real e os totais reais de `usage`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é `{ as_of_seq, epoch, session, messages, in_flight_turn, subagents?, pending_approvals, pending_questions }`: `session` é [o objeto de sessão](#o-objeto-de-sessão), `messages` são as 100 mensagens mais recentes como `{ items, has_more }`, `in_flight_turn` é o turno parcialmente em streaming (`null` quando ocioso, com `current_prompt_id` quando conhecido), `subagents` lista as tarefas de subagentes em tempo real, e `pending_approvals` / `pending_questions` carregam as interações não respondidas.

- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/media/{file_id}`

Baixa um arquivo de mídia de prompt (uma imagem ou outro anexo referenciado pelos prompts da sessão) pelo id do arquivo; um id que ainda não foi consolidado (committed) na sessão faz fallback para os uploads preparados (staged). A resposta é binária com suporte a `Range` (206 em requisições de intervalo) — veja [Endpoints binários e de streaming](#endpoints-binários-e-de-streaming) para as convenções compartilhadas; ao contrário dos endpoints envelopados lá, uma sessão ou arquivo ausente responde com um status 404 real carregando um corpo de envelope.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `file_id` | path | string | **Obrigatório.** Id do arquivo de mídia |

### Mensagens e transcrição

Os endpoints `messages` paginam o histórico de mensagens achatado (flattened) do agente principal, enquanto os endpoints `transcript` servem a transcrição estruturada por agente — turnos, tarefas, interações, anexos — que o [Protocolo de Transcrição](#protocolo-de-transcrição) do WebSocket transmite em tempo real. Use esses endpoints para paginação de histórico e atualização (catch-up), e a assinatura WebSocket para a cauda (tail) em tempo real.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | Paginar mensagens (`before_id` / `after_id` / `role`) |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | Ler uma mensagem |
| `GET /api/v1/sessions/{session_id}/transcript` | Transcrição paginada por turno (requer `agent_id`); o estado global viaja junto, sem paginação |
| `GET /api/v1/sessions/{session_id}/transcript/ops` | Atualização (catch-up) por lote de operações (op-batch) (`since_seq`); `complete: false` significa que um refresh completo é necessário |
| `GET /api/v1/sessions/{session_id}/transcript/user-messages` | Entradas de usuário que abrem turno, sem paginação |
| `GET /api/v1/sessions/{session_id}/transcript/plan` | Conteúdo, caminho (path) e resultado da revisão do plano no modo ExitPlanMode |

#### `GET /api/v1/sessions/{session_id}/messages`

Pagina o histórico de mensagens do agente principal — a transcrição de contexto achatada compartilhada com o snapshot da sessão — as mais recentes primeiro. A paginação por cursor segue a [Paginação](#paginação); ler o histórico retoma a sessão quando ela está fria.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `before_id` | query | string | Apenas mensagens mais antigas que este id de mensagem; mutuamente exclusivo com `after_id` |
| `after_id` | query | string | Apenas mensagens mais novas que este id de mensagem; mutuamente exclusivo com `before_id` |
| `page_size` | query | integer | 1–100. Padrão `50` |
| `role` | query | string | Manter apenas uma role: `user` / `assistant` / `tool` / `system`. O filtro é aplicado após a página ser fatiada, de modo que uma página filtrada pode conter menos itens que o `page_size` enquanto `has_more` ainda for `true` — continue paginando até `has_more` ser `false` |

Em caso de sucesso, `data` é `{ items, has_more }` onde cada item é um objeto de mensagem `{ id, session_id, role, content, created_at, prompt_id?, parent_message_id?, metadata? }`; `content` é um array de partes de conteúdo no formato de transporte documentado em [Prompts](#prompts) (`text`, `tool_use`, `tool_result`, `image`, `video`, `file`, `thinking`).

- `40001`: falha de validação — por exemplo `before_id` combinado com `after_id`
- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/messages/{message_id}`

Lê uma mensagem a partir do mesmo histórico através do id.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `message_id` | path | string | **Obrigatório.** Id da mensagem |

Em caso de sucesso, `data` é o objeto de mensagem no formato de item documentado em `GET /api/v1/sessions/{session_id}/messages` acima.

- `40401`: sessão não encontrada
- `40403`: não existe mensagem com esse id nesta sessão

#### `GET /api/v1/sessions/{session_id}/transcript`

Retorna uma página da transcrição estruturada de um agente: turnos (com seus passos e quadros) mais os marcadores e referências a tarefas entre eles. Sessões ativas (live) respondem a partir do armazenamento em memória (o histórico persistido do agente requisitado é preenchido/backfilled primeiro); sessões frias reconstróem o agente a partir dos registros de transporte persistidos. Esta é a metade de histórico da superfície de transcrição — a metade de streaming ao vivo é a assinatura do [Protocolo de Transcrição](#protocolo-de-transcrição).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `agent_id` | query | string | **Obrigatório.** Agente cuja transcrição se quer ler; deve ser um id de agente simples (letras, dígitos, `.`, `_`, `-` — sem separadores de caminho) |
| `before_turn` | query | string | Apenas turnos mais antigos que este id de turno; mutuamente exclusivo com `after_turn` |
| `after_turn` | query | string | Apenas turnos mais novos que este id de turno; mutuamente exclusivo com `before_turn` |
| `page_size` | query | integer | 1–100 turnos. Padrão `20` |

A unidade de página é o turno: sem um cursor a página mais nova é retornada, e `has_more` informa se há turnos mais antigos restantes. Em caso de sucesso, `data` é `{ agent_id, items, has_more, tasks, interactions, attachments, todos, meta, agents, pending_interactions, seq? }` — `items` é a fatia paginada de turnos, `tasks` / `interactions` / `attachments` / `todos` / `meta` / `agents` / `pending_interactions` são o estado global do agente que viaja sem paginação em cada resposta, e `seq` é a marca d'água de lote de operações (op-batch) do agente para retomar o stream (apenas sessões ativas).

- `40001`: falha de validação — `before_turn` combinado com `after_turn`, ou um `agent_id` não simples
- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/transcript/ops`

Serve à atualização de ponto a ponto (point-to-point catch-up) a partir do journal de operações do servidor: os lotes de operações do journal com `seq > since_seq` para um agente, do mais antigo ao mais novo. É o equivalente REST do cursor de retomada `transcript_since` descrito em [Protocolo de Transcrição](#protocolo-de-transcrição) e compartilha o mesmo journal limitado, então a mesma regra de fallback se aplica.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `agent_id` | query | string | **Obrigatório.** Id do agente (id simples, mesma restrição que o endpoint de transcrição) |
| `since_seq` | query | integer | **Obrigatório.** A última seq de op-batch aplicada pelo chamador, mínimo `0`; os lotes acima dela são retornados |

Em caso de sucesso, `data` é `{ agent_id, batches, latest_seq, complete }`, cada lote `{ seq, ops }`. `complete: true` significa que todos os lotes até `latest_seq` estão presentes; `complete: false` significa que o journal não alcança mais o `since_seq` (ou a sessão não está de forma alguma ativa), e o chamador deve fazer o fallback para um refresh completo por `GET .../transcript`.

- `40001`: falha de validação
- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/transcript/user-messages`

Lista todas as entradas da sessão que iniciam turnos, agrupadas por agente e sem paginação: texto real de usuário, comandos slash user para habilidades e plugins, e prompts cron — distinguíveis via `origin` — mais prompts que possuem apenas anexo e são projetados com um `prompt` vazio. Entidades de anexo referenciadas pelas mensagens listadas viajam junto (apenas metadados, nunca os bytes).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `agent_id` | query | string | Ler apenas um agente (id simples). O padrão lê todos os agentes na lista |

Em caso de sucesso, `data` é `{ agents }` onde cada entrada é `{ agent_id, messages, attachments }`; uma mensagem é `{ turn_id, ordinal, state, origin, prompt, attachment_ids?, started_at? }` com `state` sendo o estado do turno (`queued` / `running` / `completed` / `failed` / `cancelled`).

- `40001`: falha de validação — um `agent_id` não simples
- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/transcript/plan`

Lê as informações de plano das chamadas da ferramenta `ExitPlanMode` de um agente — conteúdo do plano, caminho do arquivo do plano, opções oferecidas e o resultado da revisão — em ordem cronológica. O conteúdo é projetado a partir do primeiro fato disponível: a interação de aprovação vinculada (revisões interativas), a exibição do quadro da ferramenta em tempo real (modo automático), ou o texto de saída do resultado da ferramenta; cada entrada registra qual deles em `source`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `agent_id` | query | string | **Obrigatório.** Id do agente (id simples) |
| `tool_call_id` | query | string | Restringir a leitura a uma chamada de `ExitPlanMode`; ausente lista todas as chamadas com conteúdo de plano recuperável |

Em caso de sucesso, `data` é `{ agent_id, plans }` onde cada plano é `{ tool_call_id, turn_id, source, plan, path?, options?, review? }`: `source` é `interaction` / `display` / `output`, `options` são as escolhas de revisão como `{ label, description? }`, e `review` (presente apenas para revisões interativas) é `{ state, selected_option?, feedback? }` com `state` sendo um de `pending` / `approved` / `rejected` / `cancelled`.

- `40001`: falha de validação
- `40401`: sessão não encontrada
- `40416`: `tool_call_id` fornecido, mas não existe nenhuma chamada de `ExitPlanMode` com esse id

### Prompts

Um prompt é uma unidade de entrada do usuário: enviar um o enfileira no agente principal da sessão (ou em um agente nomeado), um prompt enfileirado pode ser direcionado (steered) para o turno ativo, e um prompt em execução pode ser abortado. O progresso do turno em si é transmitido por streaming pelos [eventos](#eventos) do WebSocket, não por esses endpoints.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | Prompts ativos e enfileirados |
| `POST /api/v1/sessions/{session_id}/prompts` | Enviar um prompt (array content-part, substituições opcionais de modelo / modo de permissão) |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | Direcionar prompts enfileirados para o turno ativo |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | Abortar um prompt em execução |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer` | Direcionar um prompt enfileirado |

#### `GET /api/v1/sessions/{session_id}/prompts`

Lê um snapshot da fila de prompts do agente principal.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é `{ active, queued }`: `active` é o prompt em execução (`null` quando ocioso) e `queued` lista os prompts pendentes em ordem. Um prompt é `{ prompt_id, user_message_id, status, content, created_at }` com `status` sendo um de `running` / `queued` / `blocked` e `content` no formato content-part aceito por `POST /api/v1/sessions/{session_id}/prompts`.

- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/prompts`

Envia um prompt de usuário para a sessão. Referências a mídias são validadas primeiro, depois as substituições opcionais são aplicadas ao agente alvo — `profile` (vinculado junto com `model` / `thinking`), então `model`, `thinking`, `permission_mode`, e `disabled_tools` — e o prompt é enfileirado; a resposta retorna assim que o prompt é aceito, sem esperar pelo turno. Com `skills`, o prompt é executado como uma ativação de skill empacotada (bundled) em vez de um prompt de usuário simples.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `content` | body | array | **Obrigatório.** Array não vazio de partes de conteúdo (content parts); variantes abaixo |
| `agent_id` | body | string | Agente alvo. Padrão: o agente principal |
| `prompt_id` | body | string | Id do prompt escolhido pelo cliente para envio idempotente; um id já reservado por um prompt in-flight (em andamento) falha com `40927`, um que já foi concluído falha com `40903`. Não pode ser combinado com `skills` |
| `skills` | body | array | Ativações de skills empacotadas (bundled), pelo menos 1 entrada de `{ name, args? }`; toda skill deve existir e ser ativável pelo usuário |
| `profile` | body | string | Perfil de agente a ser vinculado antes do envio |
| `model` | body | string | Alias do modelo para o qual trocar o agente |
| `thinking` | body | string | Nível de esforço do modo Thinking |
| `permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `disabled_tools` | body | array | Nomes de ferramentas a serem desabilitadas para a sessão |

O schema também aceita `metadata`, `plan_mode`, `swarm_mode`, `goal_objective` e `goal_control`, mas a rota de envio (submit) atualmente não os aplica. Cada parte de `content` é um objeto discriminado por `type`:

| Parte | Campos | Descrição |
| --- | --- | --- |
| `text` | `text` | Texto simples |
| `image` / `video` | `source` | Entrada de mídia; `source` é um de `{ kind: "url", url, id? }`, `{ kind: "base64", media_type, data }`, `{ kind: "file", file_id }` (um upload de `POST /api/v1/files`), ou `{ kind: "session_media", file_id }` (mídia já consolidada nesta sessão) |
| `file` | `file_id`, `name`, `media_type`, `size` | Um anexo de arquivo enviado (uploaded) através de `POST /api/v1/files` |

O schema também aceita as partes `tool_use`, `tool_result` e `thinking` do formato de mensagem compartilhado, mas elas não fazem sentido em um prompt de usuário. Referências `file_id` desconhecidas ou com kind incorreto são rejeitadas antes da criação do prompt e antes da aplicação de qualquer substituição (override).

Em caso de sucesso, `data` é o prompt aceito `{ prompt_id, user_message_id, status, content, created_at }`.

- `40001`: falha de validação — por exemplo `prompt_id` combinado com `skills`, ou um `profile` desconhecido
- `40110`: nenhum provedor configurado ainda — conclua o login primeiro
- `40111`: o provedor resolvido não possui credencial (`details.provider_id`)
- `40112`: a credencial do provedor foi rejeitada (`details.provider_id`)
- `40113`: o modelo não pôde ser resolvido (`details.model_id` / `details.provider_id` quando conhecidos)
- `40401`: sessão não encontrada
- `40407`: um `file_id` referenciado não existe (ou não corresponde ao media kind da parte)
- `40415`: uma entrada de `skills` nomeia uma skill desconhecida
- `40903`: `prompt_id` pertence a um prompt já concluído; `data` carrega `{ aborted: false }`
- `40912`: a skill existe mas não pode ser ativada pelo usuário
- `40927`: `prompt_id` já está reservado por um prompt in-flight

#### `POST /api/v1/sessions/{session_id}/prompts:steer`

Direciona prompts enfileirados para o turno ativo, de modo que o turno em execução os consome imediatamente em vez de terminar primeiro.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `prompt_ids` | body | array | **Obrigatório.** Array não vazio de ids de prompts enfileirados |

Em caso de sucesso, `data` é `{ steered: true, prompt_ids }`.

- `40001`: falha de validação
- `40401`: sessão não encontrada
- `40402`: um id de prompt listado não está na fila

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort`

Aborta um prompt em execução. Este endpoint e o `:steer` abaixo são despachados através de uma rota, `POST /api/v1/sessions/{session_id}/prompts/{tail}`: a parte final (tail) é analisada como `{prompt_id}:{action}`, e uma ação ausente ou desconhecida falha com `40001` (`unsupported action: ...`).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `prompt_id` | path | string | **Obrigatório.** Id do prompt |

Em caso de sucesso, `data` é `{ aborted: true }`.

- `40401`: sessão não encontrada
- `40402`: não existe prompt com esse id
- `40903`: o prompt já foi concluído; `data` carrega `{ aborted: false }`

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer`

Direciona um prompt enfileirado para o turno ativo — a forma de prompt único de `POST /api/v1/sessions/{session_id}/prompts:steer`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `prompt_id` | path | string | **Obrigatório.** Id do prompt enfileirado |

Em caso de sucesso, `data` é `{ steered: true, prompt_ids: [prompt_id] }`.

- `40401`: sessão não encontrada
- `40402`: nenhum prompt enfileirado com esse id

### Aprovações e perguntas

Aprovações e perguntas (approvals and questions) são os dois tipos de interações pendentes (pending-interaction) da sessão: uma aprovação pede permissão para uma chamada de ferramenta, uma pergunta pede uma entrada estruturada com opções rotuladas. Esses endpoints as listam e as resolvem; novas requisições chegam pelo WebSocket como `event.approval.requested` e `event.question.requested`.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/approvals` | Listar requisições de aprovação pendentes (`status=pending` é obrigatório) |
| `POST /api/v1/sessions/{session_id}/approvals/{approval_id}` | Resolver uma aprovação |
| `GET /api/v1/sessions/{session_id}/questions` | Listar perguntas pendentes (`status=pending` é obrigatório) |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}` | Responder a uma pergunta |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}:dismiss` | Descartar (dismiss) uma pergunta |

#### `GET /api/v1/sessions/{session_id}/approvals`

Lista as requisições de aprovação pendentes da sessão — os prompts de permissão gerados pelas chamadas de ferramentas. Ler a lista retoma a sessão quando ela está fria.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `status` | query | string | **Obrigatório.** Deve ser `pending` |

Em caso de sucesso, `data` é `{ items }` onde cada item é `{ approval_id, session_id, turn_id?, tool_call_id, tool_name, action, tool_input_display, created_at, expires_at }`: `tool_name` / `action` / `tool_input_display` descrevem a chamada aguardando permissão, e `expires_at` é 24 horas após `created_at`.

- `40001`: `status` faltando ou não é `pending`
- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/approvals/{approval_id}`

Resolve uma requisição de aprovação pendente, permitindo que a chamada de ferramenta que aguarda prossiga (ou não).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `approval_id` | path | string | **Obrigatório.** Id da requisição de aprovação |
| `decision` | body | string | **Obrigatório.** `approved` / `rejected` / `cancelled` |
| `scope` | body | string | Com `approved`, `session` (o único valor) também lembra da regra de aprovação pelo resto da sessão |
| `feedback` | body | string | Feedback de formato livre (free-form) repassado de volta ao agente |
| `selected_label` | body | string | O rótulo (label) da opção escolhida, quando a requisição ofereceu opções rotuladas (por exemplo, a revisão de um plano) |

Em caso de sucesso, `data` é `{ resolved: true, resolved_at }`.

- `40001`: falha de validação
- `40401`: sessão não encontrada
- `40404`: nenhuma aprovação pendente com esse id
- `40902`: a aprovação já foi resolvida; `data` carrega `{ resolved: false }`

#### `GET /api/v1/sessions/{session_id}/questions`

Lista as perguntas pendentes da sessão.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `status` | query | string | **Obrigatório.** Deve ser `pending` |

Em caso de sucesso, `data` é `{ items }` onde cada item é `{ question_id, session_id, turn_id?, tool_call_id?, questions, created_at }`. `questions` contém de 1 a 4 itens `{ id, question, header?, body?, options, multi_select?, allow_other?, other_label?, other_description? }`, cada um com 2 a 4 `options` de `{ id, label, description? }`; `multi_select` permite várias opções, `allow_other` permite uma resposta em texto livre.

- `40001`: `status` faltando ou não é `pending`
- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/questions/{question_id}`

Responde a uma pergunta pendente. Ambos os endpoints de pergunta são despachados através de uma única rota, `POST /api/v1/sessions/{session_id}/questions/{tail}`: um id de pergunta simples (bare) responde à pergunta, uma cauda `{question_id}:dismiss` a descarta (dismiss), e qualquer outra coisa falha com `40001`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `question_id` | path | string | **Obrigatório.** Id da pergunta |
| `answers` | body | object | **Obrigatório.** Mapa de id do item de pergunta (`q_0`, …) para um objeto de resposta; variantes abaixo |
| `method` | body | string | Como a resposta foi produzida: `enter` / `space` / `number_key` / `click` |
| `note` | body | string | Nota de formato livre anexada à resposta |

Cada resposta é um objeto discriminado por `kind`:

| Tipo (Kind) | Campos | Descrição |
| --- | --- | --- |
| `single` | `option_id` | Uma opção escolhida |
| `multi` | `option_ids` | Várias opções escolhidas (pelo menos 1) |
| `other` | `text` | Uma resposta em texto livre |
| `multi_with_other` | `option_ids`, `other_text` | Opções mais texto livre |
| `skipped` | — | O item foi pulado (skipped) |

Em caso de sucesso, `data` é `{ resolved: true, resolved_at }`.

- `40001`: falha de validação (`details` lista cada campo)
- `40401`: sessão não encontrada
- `40405`: nenhuma pergunta pendente com esse id
- `40902`: a pergunta já foi resolvida; `data` carrega `{ resolved: false }`

#### `POST /api/v1/sessions/{session_id}/questions/{question_id}:dismiss`

Descarta (dismiss) uma pergunta pendente sem respondê-la.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `question_id` | path | string | **Obrigatório.** Id da pergunta |

Em caso de sucesso, o `code` do envelope é `40909` (`question dismissed`) em vez de `0`, com `data` `{ dismissed: true, dismissed_at }` — clientes devem tratar o código de sucesso deste endpoint como um caso especial (special-case).

- `40401`: sessão não encontrada
- `40405`: nenhuma pergunta pendente com esse id
- `40902`: a pergunta já foi resolvida; `data` carrega `{ resolved: false }`

### Tarefas em background

Tarefas em background são as unidades assíncronas da sessão — shells em background, subagentes e tarefas de ferramentas de longa duração (long-running). O registro é estritamente em tempo real (live-only): uma sessão não carregada neste processo do servidor relata uma lista vazia.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/tasks` | Listar tarefas em background |
| `GET /api/v1/sessions/{session_id}/tasks/{task_id}` | Ler uma tarefa (visualização de saída opcional) |
| `POST /api/v1/sessions/{session_id}/tasks/{task_id}:cancel` | Cancelar uma tarefa |
| `POST /api/v1/sessions/{session_id}/tasks/{task_id}:detach` | Mover uma tarefa de primeiro plano (foreground) para o background |

#### `GET /api/v1/sessions/{session_id}/tasks`

Lista as tarefas em background da sessão.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `status` | query | string | Manter apenas um status: `running` / `completed` / `failed` / `cancelled` |

Em caso de sucesso, `data` é `{ items }` onde cada item é um objeto de tarefa `{ id, session_id, kind, description, status, created_at, started_at?, completed_at?, command?, model?, thinking_effort?, agent_id?, subagent_type?, parent_tool_call_id?, output_preview?, output_bytes? }`. `kind` é `bash` / `subagent` / `tool`; `command` é definido para tarefas `bash`, os campos de modelo e agente para tarefas `subagent`, e os campos de saída apenas quando uma tarefa é lida com `with_output`. Tarefas que esgotaram o tempo limite (timed-out) e tarefas perdidas relatam `failed`; tarefas encerradas (killed) relatam `cancelled`.

- `40001`: falha de validação — um `status` desconhecido
- `40401`: sessão não encontrada

#### `GET /api/v1/sessions/{session_id}/tasks/{task_id}`

Lê uma tarefa em background, opcionalmente com uma cauda (tail) de sua saída.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `task_id` | path | string | **Obrigatório.** Id da tarefa |
| `with_output` | query | boolean | Incluir uma cauda de saída na resposta. Padrão `false` |
| `output_bytes` | query | integer | Tamanho da cauda de saída requisitada em bytes, mínimo `0`. Padrão `32768` |

Em caso de sucesso, `data` é o objeto de tarefa documentado em `GET /api/v1/sessions/{session_id}/tasks` acima; com `with_output=true` e saída não vazia, `output_preview` carrega o texto da cauda e `output_bytes` seu comprimento em bytes.

- `40001`: falha de validação
- `40401`: sessão não encontrada
- `40406`: não existe tarefa com esse id (uma sessão fria não possui nenhuma tarefa em tempo real)

#### `POST /api/v1/sessions/{session_id}/tasks/{task_id}:cancel`

Cancela uma tarefa em execução. É despachado através de `POST /api/v1/sessions/{session_id}/tasks/{tail}` com `cancel` / `detach` como as ações suportadas — um id de tarefa simples (bare) ou uma ação desconhecida falha com `40001`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `task_id` | path | string | **Obrigatório.** Id da tarefa |

Em caso de sucesso, `data` é `{ cancelled: true }`.

- `40001`: sufixo de ação ausente ou desconhecido
- `40401`: sessão não encontrada
- `40406`: não existe tarefa com esse id
- `40904`: a tarefa já foi finalizada; `data` carrega `{ cancelled: false }` e `details.current_status` o status terminal

#### `POST /api/v1/sessions/{session_id}/tasks/{task_id}:detach`

Move uma tarefa em execução no primeiro plano (foreground) para o background sem pará-la: a chamada de ferramenta que aguarda a tarefa retorna imediatamente com um resultado de tarefa em background, o turno continua, e a tarefa continua rodando sob o registro de tarefas em background (sua saída é persistida, e sua conclusão chega como uma notificação de tarefa). Tarefas já em background ou concluídas são um no-op idempotente. É despachado através de `POST /api/v1/sessions/{session_id}/tasks/{tail}` com `cancel` / `detach` como as ações suportadas — um id de tarefa simples (bare) ou uma ação desconhecida falha com `40001`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `task_id` | path | string | **Obrigatório.** Id da tarefa |

Em caso de sucesso, `data` é `{ detached, status }`: `detached` é `true` quando a chamada moveu uma tarefa em primeiro plano em execução para o background e `false` para o no-op idempotente; `status` é o status da tarefa após a chamada.

- `40001`: sufixo de ação ausente ou desconhecido
- `40401`: sessão não encontrada
- `40406`: não existe tarefa com esse id

### Skills, ferramentas e MCP

Estes endpoints expõem os catálogos de skills que uma sessão ou workspace vê, a lista de ferramentas do agente efetivo, e seus servidores MCP. A ativação de skill e a reinicialização de MCP usam a convenção `:{action}`; a ativação é o análogo REST do comando slash `/<skill>`.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | Catálogo de skills por sessão |
| `GET /api/v1/workspaces/{workspace_id}/skills` | Catálogo de skills sem sessão para um workspace |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | Ativar uma skill (inicia um turno) |
| `GET /api/v1/tools` | Listar ferramentas do agente efetivo |
| `GET /api/v1/mcp/servers` | Listar servidores MCP |
| `POST /api/v1/mcp/servers/{mcp_server_id}:restart` | Reiniciar um servidor MCP |

#### `GET /api/v1/sessions/{session_id}/skills`

Lista as skills disponíveis para uma sessão, mescladas a partir de todas as fontes (embutida, plugin, extra, usuário, projeto) com a precedência da sessão aplicada. Ler o catálogo retoma a sessão quando ela está fria.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é `{ skills }` onde cada item é um descritor de skill `{ name, description, path, source, type?, disable_model_invocation? }`: `source` é `project` / `user` / `extra` / `builtin`, `type` classifica a skill (apenas tipos ativáveis pelo usuário podem ser ativados), e `disable_model_invocation` oculta a skill do modelo.

- `40401`: sessão não encontrada (ou não ativada)

#### `GET /api/v1/workspaces/{workspace_id}/skills`

Lista o catálogo de skills que uma sessão neste workspace veria, sem criar ou retomar uma sessão — a mesma mescla de fontes embutida, plugin, extra, usuário e projeto computada para a raiz do workspace.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Obrigatório.** Id do workspace registrado |

Em caso de sucesso, `data` é `{ skills }` com o descritor de skill documentado em `GET /api/v1/sessions/{session_id}/skills` acima.

- `40410`: workspace não encontrado

#### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

Ativa uma skill na sessão — o análogo REST do comando slash `/<skill>` — iniciando um turno no agente principal com o conteúdo da skill mais `args` e anexos. O endpoint é despachado através de uma única rota, `POST /api/v1/sessions/{session_id}/skills/{tail}`: a parte final (tail) é analisada como `{skill_name}:{action}`, `activate` é a única ação, e um nome simples (bare) ou uma ação desconhecida falha com `40001` (`unsupported action: ...`).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `skill_name` | path | string | **Obrigatório.** Nome da skill a ser ativada |
| `args` | body | string | Argumentos em formato livre (free-form) passados para a skill, como o texto após um comando slash |
| `attachments` | body | array | Partes de mídia anexadas à ativação. Partes de imagem e vídeo carregam um objeto `source` cujo `kind` é `url` / `base64` / `file` / `session_media` (mesmos formatos das partes de conteúdo de prompt); partes de arquivo carregam `file_id` no nível superior, `name`, `media_type` e `size` |

Em caso de sucesso, `data` é `{ activated: true, skill_name }`.

- `40001`: falha de validação ou sufixo de ação não suportado
- `40401`: sessão não encontrada (ou não ativada)
- `40407`: um arquivo de anexo referenciado não existe
- `40415`: nenhuma skill com esse nome
- `40912`: a skill existe mas seu tipo não pode ser ativado pelo usuário

#### `GET /api/v1/tools`

Lista as ferramentas do agente efetivo — o agente principal da sessão fornecida por `session_id`, ou da sessão criada mais recentemente quando o parâmetro é omitido. Quando nenhuma sessão desse tipo está em tempo real neste processo do servidor, a lista é vazia.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | query | string | Sessão cujo agente principal deve ser inspecionado. O padrão é a sessão criada mais recentemente |

Em caso de sucesso, `data` é `{ tools }` onde cada item é `{ name, description, input_schema, source, mcp_server_id?, active? }`: `source` é `builtin` / `skill` / `mcp`, `mcp_server_id` é definido em ferramentas MCP (analisado (parsed) a partir do nome `mcp__<server>__<tool>`), e `active` relata o veredito da política de ferramentas. `input_schema` é atualmente sempre `null`.

#### `GET /api/v1/mcp/servers`

Lista os servidores MCP configurados para o agente efetivo (o agente principal da sessão em tempo real criada mais recentemente, como em `GET /api/v1/tools`). Sem nenhuma sessão em tempo real, a lista é vazia.

Em caso de sucesso, `data` é `{ servers }` onde cada item é `{ id, name, transport, status, last_error?, tool_count }`: `transport` é `stdio` / `http` / `sse`, `status` é `connected` / `connecting` / `disconnected` / `error`, e `last_error` carrega o texto de falha quando o servidor está em `error`.

#### `POST /api/v1/mcp/servers/{mcp_server_id}:restart`

Reconecta um servidor MCP do agente efetivo. O endpoint é despachado através de `POST /api/v1/mcp/servers/{tail}` com `restart` como a única ação — um id de servidor simples (bare) ou uma ação desconhecida falha com `40001`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `mcp_server_id` | path | string | **Obrigatório.** Id do servidor MCP (seu nome configurado) |

Em caso de sucesso, `data` é `{ restarting: true }`.

- `40001`: sufixo de ação ausente ou desconhecido
- `40408`: nenhum servidor MCP com esse id (também relatado quando não há sessão em tempo real)

### Capacidades e plugins

Capacidades (capabilities) são recursos embutidos com prontidão (readiness) em camadas — passos de detecção mais uma instalação em background; a build atual registra `kimi-cu` (Kimi Computer Use) e `kimi-webbridge` (Kimi WebBridge). Plugins são pacotes instalados de skills, servidores MCP, hooks e comandos. Estes endpoints relatam o status de capacidade e conduzem instalações de capacidade, e gerenciam o ciclo de vida dos plugins, desde a listagem no marketplace até a remoção.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/capabilities` | Listar capacidades embutidas com status de prontidão |
| `GET /api/v1/capabilities/{capability_id}` | Ler o status de uma capacidade |
| `POST /api/v1/capabilities/{capability_id}:install` | Iniciar a instalação de uma capacidade (em background; faça polling de GET para progresso) |
| `GET /api/v1/plugins` | Listar plugins instalados |
| `POST /api/v1/plugins` | Instalar um plugin de um caminho local, URL zip ou repositório GitHub |
| `GET /api/v1/plugins/marketplace` | Catálogo do marketplace mesclado com estado de instalação em tempo real |
| `POST /api/v1/plugins/{plugin_id}:{action}` | Ações de plugin: `enable` / `disable` / `remove` |

#### `GET /api/v1/capabilities`

Lista todas as capacidades registradas com seu status de prontidão.

Em caso de sucesso, `data` é `{ capabilities }` onde cada item é um objeto de status de capacidade `{ id, pluginId?, displayName, description, supported, state, version?, steps, install }`. `state` é `ready` (todo passo de detecção exigido está `ok`) / `partial` (algum passo está `ok`) / `not_installed` / `unsupported` (não disponível nesta plataforma/arquitetura); `steps` lista os passos de detecção como `{ id, state, detail?, optional? }` com `state` sendo um de `ok` / `missing` / `failed`; `install` é o progresso de instalação `{ running, step?, percent?, error?, note? }` com `percent` entre 0 e 100.

#### `GET /api/v1/capabilities/{capability_id}`

Lê o status de prontidão de uma capacidade — o equivalente em polling da ação `:install`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `capability_id` | path | string | **Obrigatório.** Id da capacidade |

Em caso de sucesso, `data` é o objeto de status de capacidade documentado em `GET /api/v1/capabilities` acima.

- `40418`: nenhuma capacidade com esse id

#### `POST /api/v1/capabilities/{capability_id}:install`

Inicia a instalação de uma capacidade em background e retorna imediatamente com o status atual (`install.running` é `true`); faça polling em `GET /api/v1/capabilities/{capability_id}` para obter o progresso. O endpoint é despachado através de `POST /api/v1/capabilities/{tail}` com `install` como a única ação — um id simples (bare) ou uma ação desconhecida falha com `40001`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `capability_id` | path | string | **Obrigatório.** Id da capacidade |

Em caso de sucesso, `data` é o objeto de status de capacidade documentado em `GET /api/v1/capabilities` acima.

- `40001`: sufixo de ação ausente ou desconhecido
- `40418`: nenhuma capacidade com esse id
- `40924`: uma instalação desta capacidade já está em execução
- `40925`: a capacidade não é suportada nesta plataforma/arquitetura

#### `GET /api/v1/plugins`

Lista os plugins instalados.

Em caso de sucesso, `data` é `{ plugins }` onde cada item é `{ id, displayName, version?, enabled, state, skillCount, mcpServerCount, enabledMcpServerCount, hookCount, commandCount, hasErrors, source, originalSource?, github? }`: `state` é `ok` / `error` (falhas de carregamento também definem `hasErrors`), `source` é `local-path` / `zip-url` / `github`, e `github` carrega a proveniência `{ owner, repo, ref, installedSha? }` com `ref` sendo `{ kind: branch|tag|sha, value }` para plugins obtidos (sourced) do GitHub.

#### `POST /api/v1/plugins`

Instala um plugin e retorna seu resumo.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `source` | body | string | **Obrigatório.** De onde instalar: um caminho local absoluto, uma URL `http(s)` para um arquivo zip, ou uma URL do GitHub — `https://github.com/<owner>/<repo>`, opcionalmente fixada (pinned) com `/tree/<branch-or-sha>`, `/releases/tag/<tag>`, ou `/commit/<sha>` |

Em caso de sucesso, `data` é o resumo do plugin documentado em `GET /api/v1/plugins` acima.

- `40001`: falha de validação — por exemplo, `source` não é uma URL nem um caminho absoluto, ou o plugin falhou ao carregar
- `40409`: o caminho local não existe

#### `GET /api/v1/plugins/marketplace`

Lista o catálogo do marketplace de plugins mesclado com o estado de instalação em tempo real. O catálogo é buscado por requisição (timeout de 10 segundos) a partir da URL do marketplace configurada; com o catálogo padrão, as capacidades embutidas ausentes no catálogo são mescladas como linhas (com `capabilityId` definido) e as linhas cuja capacidade não é suportada nesta plataforma são descartadas.

Em caso de sucesso, `data` é `{ entries }` onde cada item é `{ id, tier, displayName, description?, homepage?, keywords?, version?, source, installed?, updateAvailable?, capabilityId? }`: `tier` é `official` / `curated` / `third-party`, `installed` é `{ version?, enabled }` quando o plugin está instalado, e `updateAvailable` marca linhas cuja versão do catálogo é mais nova que a versão instalada. O `source` de uma entrada alimenta o campo `source` de `POST /api/v1/plugins`.

- `50001`: o marketplace está inacessível ou retornou um catálogo inválido

#### `POST /api/v1/plugins/{plugin_id}:enable`

Habilita um plugin instalado. Ações de plugin são despachadas através de uma única rota, `POST /api/v1/plugins/{tail}`: a parte final (tail) é analisada como `{plugin_id}:{action}` com `enable` / `disable` / `remove` como as ações, e um id simples (bare) ou uma ação desconhecida falha com `40001` (`unsupported action: ...`).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **Obrigatório.** Id do plugin instalado |

Em caso de sucesso, `data` é `{ ok: true }`.

- `40001`: sufixo de ação ausente ou desconhecido
- `40419`: nenhum plugin instalado com esse id

#### `POST /api/v1/plugins/{plugin_id}:disable`

Desabilita um plugin instalado sem removê-lo; o contrato de despacho (dispatch) corresponde ao `:enable` acima.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **Obrigatório.** Id do plugin instalado |

Em caso de sucesso, `data` é `{ ok: true }`.

- `40001`: sufixo de ação ausente ou desconhecido
- `40419`: nenhum plugin instalado com esse id

#### `POST /api/v1/plugins/{plugin_id}:remove`

Remove um plugin instalado; o contrato de despacho corresponde ao `:enable` acima.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **Obrigatório.** Id do plugin instalado |

Em caso de sucesso, `data` é `{ ok: true }`.

- `40001`: sufixo de ação ausente ou desconhecido
- `40419`: nenhum plugin instalado com esse id

### Terminais

Endpoints de terminal PTY; montados apenas em binds de loopback (um bind não-loopback os ignora a menos que `--allow-remote-terminals` seja passado). A entrada, saída e redimensionamento do terminal fluem através de quadros (frames) WebSocket `terminal_*` — a superfície REST gerencia apenas o ciclo de vida do terminal.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/terminals` | Listar terminais |
| `POST /api/v1/sessions/{session_id}/terminals` | Criar um terminal |
| `GET /api/v1/sessions/{session_id}/terminals/{terminal_id}` | Ler um terminal |
| `POST /api/v1/sessions/{session_id}/terminals/{terminal_id}:close` | Fechar um terminal |

#### `GET /api/v1/sessions/{session_id}/terminals`

Lista os terminais da sessão. Ler a lista retoma a sessão quando ela está fria.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |

Em caso de sucesso, `data` é `{ items }` onde cada item é um objeto de terminal `{ id, session_id, cwd, shell, cols, rows, status, created_at, exited_at?, exit_code? }`: `status` é `running` / `exited`, e um terminal encerrado carrega `exited_at` mais `exit_code` (`null` quando o processo não relatou nenhum, por exemplo, após um sinal). O scrollback não faz parte do objeto — a saída é reproduzida (replayed) e transmitida (streamed) via WebSocket.

- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/terminals`

Cria um terminal PTY para a sessão.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `runtime_id` | body | string | Runtime no qual instanciar (spawn). Padrão `local` |
| `cwd` | body | string | Diretório de trabalho, relativo ao workspace da sessão (um caminho absoluto falha na validação). O padrão é a raiz do workspace |
| `shell` | body | string | Executável do shell. O padrão é o shell do runtime |
| `cols` | body | integer | Largura do terminal, positiva. Padrão `80` |
| `rows` | body | integer | Altura do terminal, positiva. Padrão `24` |

Em caso de sucesso, `data` é o objeto de terminal documentado em `GET /api/v1/sessions/{session_id}/terminals` acima.

- `40001`: falha de validação (`details` lista cada campo)
- `40401`: sessão não encontrada
- `41304`: `cwd` resolve para fora do workspace da sessão

#### `GET /api/v1/sessions/{session_id}/terminals/{terminal_id}`

Lê um terminal.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `terminal_id` | path | string | **Obrigatório.** Id do terminal |

Em caso de sucesso, `data` é o objeto de terminal documentado em `GET /api/v1/sessions/{session_id}/terminals` acima.

- `40401`: sessão não encontrada
- `40414`: nenhum terminal com esse id

#### `POST /api/v1/sessions/{session_id}/terminals/{terminal_id}:close`

Fecha um terminal, encerrando (killing) seu processo. O endpoint é despachado através de `POST /api/v1/sessions/{session_id}/terminals/{tail}` com `close` como a única ação — um id simples (bare) ou uma ação desconhecida falha com `40001`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** Id da sessão |
| `terminal_id` | path | string | **Obrigatório.** Id do terminal |

Em caso de sucesso, `data` é `{ closed: true }`.

- `40001`: sufixo de ação ausente ou desconhecido
- `40401`: sessão não encontrada
- `40414`: nenhum terminal com esse id

### Workspaces

Workspaces são os diretórios de projeto registrados onde as sessões residem. Estes endpoints gerenciam o registro — listar, registrar, renomear, cancelar o registro — além do estado de confiança (trust state) por workspace, que controla (gates) a configuração MCP no nível do projeto. Todo endpoint que retorna um workspace usa o formato de transporte (wire shape) documentado uma vez em [O objeto de workspace](#o-objeto-de-workspace).

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/workspaces` | Listar workspaces registrados |
| `POST /api/v1/workspaces` | Registrar um workspace (idempotente no caminho raiz) |
| `PATCH /api/v1/workspaces/{workspace_id}` | Renomear |
| `DELETE /api/v1/workspaces/{workspace_id}` | Cancelar registro (mantém o conteúdo no disco) |
| `GET /api/v1/workspaces/{workspace_id}/trust` | Ler o estado de confiança |
| `POST /api/v1/workspaces/{workspace_id}/trust` | Conceder confiança |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | Revogar confiança |
| `POST /api/v1/workspaces/{workspace_id}/add-dir` | Adicionar um diretório adicional |

#### O objeto de workspace

Todo endpoint que retorna um workspace usa este formato de transporte (wire shape). O registro e a renomeação transmitem os eventos globais `event.workspace.created` / `event.workspace.updated`.

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `id` | string | Id do workspace, uma string `wd_<slug>_<hash12>` derivada do caminho raiz |
| `root` | string | Caminho absoluto do diretório do projeto |
| `name` | string | Nome de exibição, 1–100 caracteres; o padrão é o nome base do diretório raiz |
| `created_at` | string | Tempo de registro, ISO 8601 |
| `last_opened_at` | string | Última vez que o workspace foi aberto ou re-registrado, ISO 8601 |
| `session_count` | integer | Número de sessões no workspace |

#### `GET /api/v1/workspaces`

Lista todos os workspaces registrados.

Em caso de sucesso, `data` é `{ items }` onde cada item é [o objeto de workspace](#o-objeto-de-workspace).

#### `POST /api/v1/workspaces`

Registra um workspace e o retorna. O registro é idempotente no caminho raiz: registrar uma raiz já registrada retorna o workspace existente com apenas `last_opened_at` atualizado (o nome armazenado é mantido), transmitindo `event.workspace.updated` em vez de `event.workspace.created`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `root` | body | string | **Obrigatório.** Caminho absoluto de um diretório existente |
| `name` | body | string | Nome de exibição, 1–100 caracteres. O padrão é o nome base do diretório raiz |

Em caso de sucesso, `data` é [o objeto de workspace](#o-objeto-de-workspace).

- `40001`: `root` está ausente ou não é um caminho absoluto (`details` lista o campo)
- `40409`: `root` não existe ou não é um diretório

#### `PATCH /api/v1/workspaces/{workspace_id}`

Renomeia um workspace — apenas o nome de exibição; o caminho raiz nunca muda.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Obrigatório.** Id do workspace |
| `name` | body | string | **Obrigatório.** Novo nome de exibição, 1–100 caracteres |

Em caso de sucesso, `data` é [o objeto de workspace](#o-objeto-de-workspace).

- `40001`: falha de validação (`details` lista cada campo)
- `40410`: workspace não encontrado

#### `DELETE /api/v1/workspaces/{workspace_id}`

Cancela o registro de um workspace. Apenas a entrada no registro é removida — o diretório no disco permanece intacto.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Obrigatório.** Id do workspace |

Em caso de sucesso, `data` é `{ deleted: true }`.

- `40410`: workspace não encontrado

#### `GET /api/v1/workspaces/{workspace_id}/trust`

Lê o estado de confiança (trust state) do workspace. A confiança controla (gates) se a configuração MCP no nível do projeto será carregada para o workspace.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Obrigatório.** Id do workspace |

Em caso de sucesso, `data` é `{ trusted }`.

- `40410`: workspace não encontrado

#### `POST /api/v1/workspaces/{workspace_id}/trust`

Marca o workspace como confiável, carregando sua configuração MCP no nível do projeto.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Obrigatório.** Id do workspace |

Em caso de sucesso, `data` é `{ trusted: true }`.

- `40410`: workspace não encontrado

#### `POST /api/v1/workspaces/{workspace_id}/untrust`

#### `POST /api/v1/workspaces/{workspace_id}/untrust`

Revoga a confiança do workspace, descarregando sua configuração MCP no nível do projeto.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Obrigatório.** Id do workspace |

Em caso de sucesso, `data` é `{ trusted: false }`.

- `40410`: workspace não encontrado

#### `POST /api/v1/workspaces/{workspace_id}/add-dir`

Adiciona um diretório adicional ao workspace, com a mesma semântica que a flag `--add-dir` da CLI e o comando `/add-dir` da TUI. O caminho aceita caminhos absolutos, caminhos relativos (resolvidos contra a raiz do workspace) e expansão de `~`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Obrigatório.** Id do workspace |
| `path` | body | string | **Obrigatório.** Diretório a ser adicionado |
| `persist` | body | boolean | O padrão é `true`: anexa a `workspace.additional_dir` em `<project root>/.kimi-code/local.toml`. Com `false`, o diretório apenas se junta ao conjunto efêmero em memória compartilhado por todas as sessões do workspace |

Em caso de sucesso, `data` é `{ project_root, config_path, additional_dirs, persisted }`, onde `additional_dirs` lista todos os diretórios adicionais (incluindo os já existentes) e `persisted` relata se esta chamada gravou no disco.

- `40001`: falha de validação (`details` lista cada campo), ou um erro de validação de configuração no lado da engine (engine-side), como uma configuração local de projeto corrompida
- `40409`: `path` não existe ou não é um diretório
- `40410`: workspace não encontrado

### Sistema de arquivos (`File system`)

As operações de arquivos em sessão são realizadas através de `POST /api/v1/sessions/{session_id}/fs:{action}` com corpos em JSON; as ações disponíveis são `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `diff` / `open` / `open-in` / `reveal`. O corpo de cada ação também aceita um `runtime_id` opcional (string, padrão `local`) selecionando o ambiente de execução (*runtime*) que executa a operação; `open`, `open-in` e `reveal` funcionam apenas no ambiente `local`. Além disso:

| Método e caminho | Descrição |
| --- | --- |
| `POST /api/v1/workspace/fs:search` | Busca em workspace sem sessão (o corpo carrega a referência do workspace) |
| `POST /api/v1/workspace/fs:suggest` | Candidatos de autocompletar de arquivos sem sessão (para menções a arquivos com `@`) |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | Baixar um arquivo de sessão (binário, veja abaixo) |
| `GET /api/v1/fs:browse` | Listar diretórios do host (seletor de pastas) |
| `GET /api/v1/fs:home` | O diretório home do usuário e workspaces recentes |
| `GET /api/v1/fs:content` | Bytes brutos de qualquer arquivo do host (protegido apenas pelo token — tome cuidado ao expor a porta) |
| `POST /api/v1/fs:mkdir` | Criar um diretório por caminho absoluto |

#### `POST /api/v1/sessions/{session_id}/fs:list`

Lista as entradas de um diretório de workspace de sessão, recursando opcionalmente em subdiretórios.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | body | string | Diretório a listar, relativo ao diretório de trabalho da sessão. Padrão `.` |
| `depth` | body | integer | Profundidade de recursão, 1–10. Padrão `1` |
| `limit` | body | integer | Máximo de entradas, 1–1000. Padrão `200` |
| `show_hidden` | body | boolean | Incluir arquivos ocultos (dotfiles). Padrão `false` |
| `follow_gitignore` | body | boolean | Ignorar caminhos presentes no `.gitignore`. Padrão `true` |
| `exclude_globs` | body | string[] | Padrões glob adicionais a ignorar |
| `sort` | body | string | `type_first` (padrão) / `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | body | boolean | Anexar o status do git de cada entrada. Padrão `false` |

Em caso de sucesso, `data` é `{ items, truncated }` — além de `children_by_path` (um mapa de caminho → entradas) quando `depth` for maior que 1. Cada item é um objeto de entrada `{ path, name, kind, size?, modified_at, etag?, mime?, language_id?, is_binary?, is_symlink_to?, git_status?, child_count? }`, onde `kind` é `file` / `directory` / `symlink` e `git_status` (presente apenas com `include_git_status: true`) é um dentre `clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted`; `truncated` indica que o `limit` cortou a listagem.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40409`: caminho não encontrado (incluindo um `path` que não é um diretório)
- `41304`: o caminho escapa do workspace da sessão

#### `POST /api/v1/sessions/{session_id}/fs:read`

Lê um trecho (*slice*) de um arquivo de sessão como texto ou base64.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | body | string | **Obrigatório.** Caminho do arquivo, relativo ao diretório de trabalho da sessão |
| `offset` | body | integer | Deslocamento (*offset*) em bytes para iniciar. Padrão `0` |
| `length` | body | integer | Bytes a ler, 1–10485760 (10 MiB). Padrão `1048576` (1 MiB) |
| `encoding` | body | string | `auto` (padrão) / `utf-8` / `base64` |

Em caso de sucesso, `data` é `{ path, content, encoding, size, truncated, etag, mime, language_id?, line_count?, is_binary }`, onde `encoding` informa a codificação realmente utilizada (`utf-8` ou `base64`) e `size` é o tamanho total do arquivo. Com `encoding: "auto"`, o texto retorna como `utf-8` (textos que não são UTF-8 são transcodificados) e o conteúdo binário como `base64`; `encoding: "utf-8"` força texto e rejeita arquivos binários.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40409`: caminho não encontrado
- `40906`: o caminho é um diretório
- `40907`: arquivo binário solicitado com `encoding: "utf-8"`
- `41302`: o arquivo excede o limite de leitura de 10 MiB
- `41304`: o caminho escapa do workspace da sessão

#### `POST /api/v1/sessions/{session_id}/fs:list_many`

Lista vários diretórios de sessão em uma única chamada; um caminho com falha é inserido na resposta em vez de invalidar a requisição inteira.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `paths` | body | string[] | **Obrigatório.** Diretórios a listar, 1–100 entradas |

Os campos restantes do corpo (`depth`, `limit`, `show_hidden`, `follow_gitignore`, `exclude_globs`, `sort`, `include_git_status`) possuem os mesmos tipos, intervalos e padrões de `fs:list`. Em caso de sucesso, `data` é `{ results }`, um mapa de cada caminho requisitado para seu array de entradas (objetos de entrada conforme descritos em `fs:list`), além de `truncated_paths` (caminhos cuja listagem atingiu o `limit`) e `partial_errors`, um mapa de um caminho com falha para o seu erro `{ code, msg }`.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/fs:stat`

Obtém metadados (*stat*) de um caminho no workspace da sessão.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | body | string | **Obrigatório.** Caminho para o stat, relativo ao diretório de trabalho da sessão |

Em caso de sucesso, `data` é o objeto de entrada descrito em `fs:list`.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40409`: caminho não encontrado
- `41304`: o caminho escapa do workspace da sessão

#### `POST /api/v1/sessions/{session_id}/fs:stat_many`

Obtém metadados (*stat*) de vários caminhos de sessão em uma única chamada; caminhos ausentes retornam `null` em vez de falhar a requisição.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `paths` | body | string[] | **Obrigatório.** Caminhos para o stat, 1–1000 entradas |

Em caso de sucesso, `data` é `{ entries }`, um mapa de cada caminho requisitado para seu objeto de entrada (conforme descrito em `fs:list`) ou `null` quando o caminho não existe.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada

#### `POST /api/v1/sessions/{session_id}/fs:mkdir`

Cria um diretório dentro do workspace da sessão.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | body | string | **Obrigatório.** Diretório a criar, relativo ao diretório de trabalho da sessão |
| `recursive` | body | boolean | Criar diretórios pai ausentes. Padrão `false` |

Em caso de sucesso, `data` é o objeto de entrada do diretório criado (conforme descrito em `fs:list`).

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40409`: diretório pai não encontrado (criação não recursiva)
- `40919`: o caminho já existe (criação não recursiva)
- `41304`: o caminho escapa do workspace da sessão

#### `POST /api/v1/sessions/{session_id}/fs:search`

Realiza busca por aproximação (*fuzzy-search*) de nomes de arquivos e diretórios em todo o workspace da sessão. Um `query` vazio lista as entradas de nível superior. Quando o espaço `{session_id}` carrega uma referência de workspace (um ID de workspace registrado ou uma raiz absoluta) em vez de um ID de sessão, a busca é executada contra esse workspace — o formato sem sessão para uma sessão de rascunho ainda não criada; o endpoint oficial sem sessão é `POST /api/v1/workspace/fs:search`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão ou referência de workspace |
| `query` | body | string | **Obrigatório.** Texto de busca; `""` lista o nível superior |
| `limit` | body | integer | Máximo de ocorrências, 1–200. Padrão `50` |
| `include_globs` | body | string[] | Apenas caminhos correspondentes a um destes globs |
| `exclude_globs` | body | string[] | Ignorar caminhos correspondentes a estes globs |
| `follow_gitignore` | body | boolean | Ignorar caminhos presentes no `.gitignore`. Padrão `true` |

Em caso de sucesso, `data` é `{ items, truncated }` onde cada item é `{ path, name, kind, score, match_positions }` — `kind` é `file` / `directory` / `symlink`, `score` é a pontuação da busca por aproximação entre 0 e 1, e `match_positions` lista os deslocamentos dos caracteres correspondentes. As ocorrências são ordenadas por pontuação (desempate por caminho), e `truncated` indica que ocorrências além do `limit` foram descartadas.

- `40001`: falha de validação do corpo
- `40401`: não é uma sessão nem um workspace resolvível com essa referência

#### `POST /api/v1/sessions/{session_id}/fs:grep`

Pesquisa conteúdos de arquivos em todo o workspace da sessão — por padrão uma string literal, ou uma expressão regular com `regex: true`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `pattern` | body | string | **Obrigatório.** Texto ou expressão regular a ser pesquisada |
| `regex` | body | boolean | Tratar `pattern` como expressão regular. Padrão `false` |
| `case_sensitive` | body | boolean | Distinguir maiúsculas de minúsculas (*case sensitive*). Padrão `true` |
| `include_globs` | body | string[] | Apenas arquivos correspondentes a um destes globs |
| `exclude_globs` | body | string[] | Ignorar arquivos correspondentes a estes globs |
| `follow_gitignore` | body | boolean | Ignorar caminhos presentes no `.gitignore`. Padrão `true` |
| `max_files` | body | integer | Máximo de arquivos a varrer, 1–10000. Padrão `200` |
| `max_matches_per_file` | body | integer | Ocorrências mantidas por arquivo, 1–10000. Padrão `50` |
| `max_total_matches` | body | integer | Ocorrências mantidas no total, 1–100000. Padrão `5000` |
| `context_lines` | body | integer | Linhas de contexto ao redor de cada ocorrência, 0–10. Padrão `2` |

Em caso de sucesso, `data` é `{ files, files_scanned, truncated, elapsed_ms }` onde cada entrada de `files` é `{ path, matches }` e cada ocorrência é `{ line, col, text, before, after }` (`before` / `after` contêm até `context_lines` linhas ao redor); `truncated` indica que um dos limites de orçamento de ocorrências encerrou os resultados antecipadamente.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `41305`: a busca esgotou o tempo limite (*timeout*)

#### `POST /api/v1/sessions/{session_id}/fs:git_status`

Lê o status do git do workspace da sessão, restrito opcionalmente a um conjunto de caminhos.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `paths` | body | string[] | Restringir o status a estes caminhos; omitido significa o workspace inteiro |

Em caso de sucesso, `data` é `{ branch, ahead, behind, entries, additions, deletions, pullRequest }` onde `entries` mapeia cada caminho alterado para seu status (`clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted`) e `pullRequest` é `{ number, state, url }` (`state` é `open` / `merged` / `closed` / `draft`) ou `null`.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40908`: o git está indisponível (não é um repositório ou não há binário do git)

#### `POST /api/v1/sessions/{session_id}/fs:diff`

Retorna o diff unificado do git de um arquivo no workspace da sessão.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | body | string | **Obrigatório.** Arquivo para o diff, relativo ao diretório de trabalho da sessão |

Em caso de sucesso, `data` é `{ path, diff, truncated }` onde `diff` é o texto do diff unificado e `truncated` indica um diff excessivamente longo cortado.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40908`: o git está indisponível (não é um repositório ou não há binário do git)
- `41304`: o caminho escapa do workspace da sessão

#### `POST /api/v1/sessions/{session_id}/fs:open`

Abre um arquivo de sessão com o manipulador padrão do sistema operacional do host. Exclusivo para o ambiente local (*local runtime*).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | body | string | **Obrigatório.** Arquivo a abrir, relativo ao diretório de trabalho da sessão |
| `line` | body | integer | Número da linha para saltar onde o manipulador suportar (inteiro positivo) |

Em caso de sucesso, `data` é `{ opened: true }`.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40409`: caminho não encontrado
- `41304`: o caminho escapa do workspace da sessão

#### `POST /api/v1/sessions/{session_id}/fs:open-in`

Abre um arquivo ou diretório de sessão em um aplicativo específico do host. Exclusivo para o ambiente local.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `app_id` | body | string | **Obrigatório.** Aplicativo de destino: `finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | body | string | **Obrigatório.** Arquivo ou diretório a abrir, relativo ao diretório de trabalho da sessão |
| `line` | body | integer | Número da linha para saltar onde o aplicativo suportar (inteiro positivo) |

Em caso de sucesso, `data` é `{ opened: true }`.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40409`: caminho não encontrado
- `41304`: o caminho escapa do workspace da sessão
- `50001`: falha ao iniciar o aplicativo

#### `POST /api/v1/sessions/{session_id}/fs:reveal`

Revela um arquivo de sessão no gerenciador de arquivos do sistema operacional do host. Exclusivo para o ambiente local.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | body | string | **Obrigatório.** Arquivo a revelar, relativo ao diretório de trabalho da sessão |

Em caso de sucesso, `data` é `{ revealed: true }`.

- `40001`: falha de validação do corpo
- `40401`: sessão não encontrada
- `40409`: caminho não encontrado
- `41304`: o caminho escapa do workspace da sessão

#### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

Baixa um arquivo do workspace da sessão; `{path}` é o caminho do arquivo relativo ao workspace com o sufixo literal `:download`. A resposta é um fluxo binário (*binary stream*) com suporte a intervalo (*range*) e ETag — consulte [Endpoints binários e de streaming](#endpoints-binários-e-de-streaming).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `session_id` | path | string | **Obrigatório.** ID da sessão |
| `path` | path | string | **Obrigatório.** Caminho do arquivo relativo ao workspace acrescido do sufixo `:download` |
| `runtime_id` | query | string | Ambiente de execução para leitura. Padrão `local` |

- `40001`: caminho ausente ou vazio
- `40401`: sessão não encontrada
- `40409`: caminho não encontrado
- `41304`: o caminho escapa do workspace da sessão

#### `POST /api/v1/workspace/fs:search`

A forma sem sessão de `fs:search`: o workspace trafega no corpo da requisição em vez da URL.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace` | body | string | **Obrigatório.** ID de workspace registrado ou raiz absoluta (registrada no momento) |
| `query` | body | string | **Obrigatório.** Texto de busca; `""` lista o nível superior |
| `limit` | body | integer | Máximo de ocorrências, 1–200. Padrão `50` |
| `include_globs` | body | string[] | Apenas caminhos correspondentes a um destes globs |
| `exclude_globs` | body | string[] | Ignorar caminhos correspondentes a estes globs |
| `follow_gitignore` | body | boolean | Ignorar caminhos presentes no `.gitignore`. Padrão `true` |
| `runtime_id` | body | string | Ambiente de execução para realizar a busca. Padrão `local` |

Em caso de sucesso, `data` é `{ items, truncated }` com a mesma estrutura de ocorrências e ordenação de `fs:search`.

- `40001`: falha de validação do corpo
- `40410`: workspace não encontrado e não é um caminho absoluto utilizável

#### `POST /api/v1/workspace/fs:suggest`

Sugere candidatos de autocompletar de arquivos e diretórios em um workspace sem sessão — o backend para menções a arquivos com `@` no compositor.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `workspace` | body | string | **Obrigatório.** ID de workspace registrado ou raiz absoluta (registrada no momento) |
| `query` | body | string | **Obrigatório.** Texto de caminho parcial para autocompletar |
| `limit` | body | integer | Máximo de candidatos, 1–200. Padrão `50` |
| `follow_gitignore` | body | boolean | Ignorar caminhos presentes no `.gitignore`. Padrão `true` |
| `show_hidden` | body | boolean | Incluir arquivos ocultos (dotfiles). Padrão `false` |
| `include_globs` | body | string[] | Apenas caminhos correspondentes a um destes globs |
| `exclude_globs` | body | string[] | Ignorar caminhos correspondentes a estes globs |
| `runtime_id` | body | string | Ambiente de execução para autocompletar. Padrão `local` |

Em caso de sucesso, `data` é `{ items, truncated }` onde cada item é `{ path, name, kind, score, match_positions }`, a mesma estrutura de ocorrências de `fs:search`.

- `40001`: falha de validação do corpo
- `40410`: workspace não encontrado e não é um caminho absoluto utilizável

#### `GET /api/v1/fs:browse`

Lista os subdiretórios de um diretório do host — o backend do seletor de pastas.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `path` | query | string | Caminho absoluto do diretório. O padrão é o diretório home do usuário |

Em caso de sucesso, `data` é `{ path, parent, entries }` onde `path` é o diretório resolvido, `parent` é o seu diretório pai (`null` na raiz do sistema de arquivos), e cada entrada é `{ name, path, is_dir: true }`.

- `40001`: `path` não é absoluto
- `40409`: caminho não encontrado
- `40411`: permissão negada

#### `GET /api/v1/fs:home`

Retorna os dados iniciais (*landing payload*) do seletor de pastas. Sem parâmetros.

Em caso de sucesso, `data` é `{ home, recent_roots }` onde `home` é o diretório home do usuário e `recent_roots` lista as raízes dos workspaces registrados.

#### `GET /api/v1/fs:content`

Transmite os bytes brutos de qualquer arquivo no sistema de arquivos do host — protegido apenas pelo token — tome cuidado ao expor a porta. Requisições por intervalo (*Range requests*) e cache via ETag são suportados; consulte [Endpoints binários e de streaming](#endpoints-binários-e-de-streaming).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `path` | query | string | **Obrigatório.** Caminho absoluto do arquivo |

- `40001`: `path` não é absoluto ou não é um arquivo regular
- `40409`: caminho não encontrado
- `40411`: permissão negada
- `40906`: o caminho é um diretório

#### `POST /api/v1/fs:mkdir`

Cria um diretório no sistema de arquivos do host por caminho absoluto — o backend de "nova pasta" do seletor de pastas. Não recursivo: o diretório pai já deve existir.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `path` | body | string | **Obrigatório.** Caminho absoluto do diretório |

Em caso de sucesso, `data` é `{ path }`.

- `40001`: `path` não é absoluto
- `40409`: caminho pai não encontrado
- `40411`: permissão negada
- `40919`: o caminho já existe

### Uploads de arquivos (`File uploads`)

| Método e caminho | Descrição |
| --- | --- |
| `POST /api/v1/files` | Upload multipart (campo `file`, opcionais `name` e `expires_in_sec`); retorna metadados do arquivo |
| `GET /api/v1/files/{file_id}` | Download (binário; erros usam status HTTP reais) |
| `DELETE /api/v1/files/{file_id}` | Excluir |

#### `POST /api/v1/files`

Faz o upload de um arquivo como `multipart/form-data` para referência posterior (por exemplo, como anexo de prompt).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `file` | body | binary | **Obrigatório.** A parte de arquivo multipart |
| `name` | body | string | Nome de exibição armazenado. O padrão é o nome do arquivo enviado |
| `expires_in_sec` | body | number | Segundos até o arquivo expirar (não negativo). O padrão é nunca expirar |

Em caso de sucesso, `data` é o metadado do arquivo `{ id, name, media_type, size, created_at, expires_at? }` com `media_type` obtido do tipo de conteúdo do upload.

- `40001`: o corpo multipart não possui o campo `file`

#### `GET /api/v1/files/{file_id}`

Baixa um arquivo enviado. A resposta é um fluxo binário que honra requisições de intervalo (*range requests*), mas ignora `If-None-Match`; falhas utilizam status HTTP reais — consulte [Endpoints binários e de streaming](#endpoints-binários-e-de-streaming).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `file_id` | path | string | **Obrigatório.** ID do arquivo retornado na resposta do upload |

- `40407` (HTTP 404): nenhum arquivo com esse ID (incluindo arquivo expirado)

#### `DELETE /api/v1/files/{file_id}`

Exclui um arquivo enviado.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `file_id` | path | string | **Obrigatório.** ID do arquivo retornado na resposta do upload |

Em caso de sucesso, `data` é `{ deleted: true }`.

- `40407` (HTTP 404): nenhum arquivo com esse ID

### Armazenamento da GUI (`GUI store`)

Um armazenamento de chave/valor respaldado pelo servidor que espelha a interface `localStorage` do navegador, persistido sob o diretório home do servidor; a UI web mantém o estado de interface entre clientes aqui. Os valores são strings opacas — a serialização é responsabilidade do chamador.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v1/gui/store/length` | Número de chaves armazenadas |
| `GET /api/v1/gui/store/getItem` | Ler um valor por chave |
| `POST /api/v1/gui/store/setItem` | Escrever um valor por chave |
| `POST /api/v1/gui/store/removeItem` | Excluir um valor por chave |
| `POST /api/v1/gui/store/clear` | Excluir todos os valores |

#### `GET /api/v1/gui/store/length`

Retorna o número de chaves armazenadas (espelha `localStorage.length`). Sem parâmetros.

Em caso de sucesso, `data` é `{ length }`.

#### `GET /api/v1/gui/store/getItem`

Lê um valor (espelha `localStorage.getItem`).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `key` | query | string | **Obrigatório.** Chave a ler, 1–256 caracteres |

Em caso de sucesso, `data` é `{ value }`, a string armazenada ou `null` quando a chave não existir.

#### `POST /api/v1/gui/store/setItem`

Escreve um valor (espelha `localStorage.setItem`).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `key` | body | string | **Obrigatório.** Chave a escrever, 1–256 caracteres |
| `value` | body | string | **Obrigatório.** Valor a armazenar |

Em caso de sucesso, `data` é `null`.

#### `POST /api/v1/gui/store/removeItem`

Exclui um valor (espelha `localStorage.removeItem`).

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `key` | body | string | **Obrigatório.** Chave a excluir, 1–256 caracteres |

Em caso de sucesso, `data` é `null`.

#### `POST /api/v1/gui/store/clear`

Exclui todos os valores armazenados (espelha `localStorage.clear`). Sem parâmetros.

Em caso de sucesso, `data` é `null`.

### Busca global e diversos (`Global search and misc`)

| Método e caminho | Descrição |
| --- | --- |
| `POST /api/v1/search` | Busca de texto completo entre sessões (*cross-session full-text search*); `mode` é `terms` (padrão) ou `literal` (substring exata); paginação via `page_token` |
| `GET /api/v1/connections` | Listar conexões WebSocket ativas |
| `GET /api/v2/sessions` | Lista de sessões de nova geração, veja abaixo |
| `POST /api/v2/sessions:archive` | Arquivamento em lote de sessões, veja abaixo |
| `POST /api/v2/sessions:restore` | Restauração em lote de sessões arquivadas, veja abaixo |
| `/api/v2/mcp/*` | Plano de gerenciamento unificado de MCP, veja abaixo |
| `/api/v1/debug/*` | RPC de depuração/reflexão; montado apenas com `--debug-endpoints` em loopback, não é um protocolo estável |

#### `POST /api/v1/search`

Busca de texto completo entre sessões em mensagens de usuários, respostas de assistentes e títulos de sessão, respaldada pelo índice de busca persistente do servidor. Quando `container.session_id` aponta para uma sessão ativa neste processo de servidor, a busca varre diretamente a transcrição em memória dessa sessão, e o campo `source` da resposta (`index` ou `live`) indica qual caminho atendeu à página.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `query` | body | string | **Obrigatório.** Texto de busca |
| `mode` | body | string | `terms` (padrão) / `literal` |
| `op` | body | string | Combinador de termos no modo `terms`: `AND` (padrão) / `OR` |
| `container` | body | object | Restringir a busca a `{ session_id?, agent_id? }` |
| `role` | body | string | Restringir a ocorrências de `user` / `assistant` / `title` |
| `start_time` | body | integer | Apenas ocorrências a partir deste horário (milissegundos de época) |
| `end_time` | body | integer | Apenas ocorrências até este horário (milissegundos de época) |
| `sort` | body | string | `score` (padrão) / `time_desc` / `time_asc`; ignorado pelo modo `literal`, que sempre retorna do mais recente para o mais antigo |
| `page_size` | body | integer | Ocorrências por página, 1–50. Padrão `20` |
| `page_token` | body | string | Token da resposta da página anterior |

No modo `terms`, a consulta é tokenizada (palavras em ASCII mais n-gramas CJK), deduplicada e combinada com o índice invertido usando no máximo 32 termos; o modo `literal` é uma busca de substring exata com zero falsos positivos. Em caso de sucesso, `data` é `{ items, has_more, page_token?, index_state, source }` onde cada item é `{ session_id, workspace_id, session_title, agent_id, role, snippet, time, turn?, step_id?, score }`. `index_state` é `{ state, indexed_sessions, total_sessions, documents, stale?, degraded? }` com `state` sendo um dentre `building` / `ready` / `readonly`; `stale` sinaliza uma visão atrasada que ainda está se atualizando, e `degraded` carrega a falha da última atualização. Uma página que exceda o orçamento carrega adicionalmente `incomplete`, sendo um dentre `candidate_cap` / `postings_budget` / `deadline`. Tokens de página fixam a geração do índice e as condições de consulta — uma reconstrução ou uma consulta alterada os invalida.

- `40001`: falha de validação do corpo, consulta inutilizável (vazia ou com mais de 32 termos) ou token de página inválido

#### `GET /api/v1/connections`

Lista os clientes WebSocket atualmente conectados a este servidor, ordenados da conexão mais antiga para a mais recente. Sem parâmetros.

Em caso de sucesso, `data` é `{ connections }` onde cada item é `{ id, connected_at, remote_address, user_agent, has_client_hello, subscriptions }`: `connected_at` é um timestamp ISO 8601, `remote_address` e `user_agent` são `null` quando desconhecidos, `has_client_hello` indica se o cliente enviou seu quadro de handshake, e `subscriptions` lista os IDs de sessão aos quais a conexão está inscrita.

### `GET /api/v2/sessions`

Uma consulta de sessão de nova geração para visualizações em lista — filtragem, ordenação e grupos de campos trafegam em parâmetros de query:

| Parâmetro | Descrição |
| --- | --- |
| `workspace.id` | Filtrar por workspace; repetível |
| `activity.status` | Filtrar por status de atividade: `running` / `approval` / `question` / `failed` / `idle`; repetível |
| `meta.updated_after` | Apenas sessões atualizadas após este horário (milissegundos de época) |
| `meta.updated_before` | Apenas sessões atualizadas antes deste horário (milissegundos de época) |
| `meta.archived` | `true` / `false` (padrão) / `all` |
| `meta.has_prompt` | `true` mantém apenas sessões que contêm um prompt de usuário, `false` mantém apenas as vazias (o equivalente a `exclude_empty` do `GET /api/v1/sessions`) |
| `view` | `flat` (padrão) / `by_workspace`, veja abaixo |
| `group.page_size` | Sessões retornadas por workspace sob `view=by_workspace`: 1–100, padrão 5 (até 10000 com a projeção `id,archived`); rejeitado sem a visualização agrupada (`40001`) |
| `sort` | `meta.updated_at_desc` (padrão) / `meta.updated_at_asc` / `meta.created_at_desc` |
| `include` | Grupos de campos extras separados por vírgula; atualmente apenas `git` (informações de branch e PR, deduplicadas por diretório e armazenadas em cache por 60 segundos) |
| `fields` | Projeção de itens separada por vírgula; atualmente apenas `id,archived`, reduzindo cada item a `{ id, archived }` (fluxos de seleção de todos os correspondentes). Incompatível com `include=git` (`40001`) |
| `page_size` | 1–100, padrão 50; até 10000 com a projeção `id,archived`. Sob `view=by_workspace`, conta grupos por página |
| `page_token` | Token de paginação da página anterior |
| `page` | Número de página apátrida baseado em 1; mutuamente exclusivo com `page_token` (`40001` quando combinados) |

Cada item de resposta carrega os grupos `workspace`, `meta` e `activity`, além de `git` quando `include=git` — ou apenas `{ id, archived }` sob `fields=id,archived`. O grupo `activity` também relata `model`: o alias do modelo vinculado à sessão enquanto estiver ativo neste processo, ou `null` para sessões frias (não carregadas no momento). Cada página carrega adicionalmente `total`, o tamanho do conjunto filtrado. O token de página vincula as condições de query da primeira página (incluindo a projeção); alterá-los no meio da paginação retorna `40922`. O modo `page` é uma alternativa apátrida para saltar para páginas arbitrárias: cada requisição é um snapshot independente, nenhum token é gerado e `next_page_token` é sempre `null`.

Com `view=by_workspace`, o mesmo conjunto filtrado e ordenado é reprojetado em grupos por workspace, permitindo que um cliente de visão geral substitua um loop de polling por workspace por uma única requisição:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "groups": [
      {
        "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" },
        "sessions": [ { "id": "session_...", "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" }, "meta": { "title": "Fix the login page", "last_prompt": "adjust the button spacing", "created_at": 1787000000000, "updated_at": 1787000100000, "archived": false, "archived_at": null }, "activity": { "status": "idle", "model": "kimi-for-coding" } } ],
        "total": 42
      }
    ],
    "total": 7,
    "has_more": true,
    "next_page_token": "eyJ2IjoxLCJmIjoi..."
  },
  "request_id": "req_..."
}
```

Cada grupo carrega as primeiras sessões de `group.page_size` do workspace sob o `sort` solicitado mais o `total`, que representa a contagem completa de sessões correspondentes do workspace (para uma entrada de "ver tudo"). Apenas workspaces com pelo menos uma sessão correspondente aparecem; os grupos são ordenados pela chave de ordenação de sua primeira sessão, com desempate pelo ID do workspace. `page` e `page_token` paginam sobre os grupos (o `total` externo é a contagem de grupos), com a mesma vinculação de impressão digital: o token também cobre `view` e os parâmetros de agrupamento, de modo que alterá-los no meio da paginação retorna `40922`.

### `POST /api/v2/sessions:archive` e `POST /api/v2/sessions:restore`

Arquivamento e restauração em lote para visualizações de gerenciamento de sessões. O corpo é `{ "ids": ["session_..."] }` — não vazio, com no máximo 5000 IDs únicos (duplicatas colapsam). Sessões ativas passam pelo ciclo de vida completo; sessões frias são atualizadas em disco sem serem carregadas.

Apenas uma falha de validação do corpo resulta em falha na requisição inteira (`40001`). Caso contrário, a resposta é por item: `data.results` mantém a ordem de entrada com `{ id, ok }` ou `{ id, ok: false, error }` (um ID desconhecido relata `40401` em seu próprio item), além das contagens de `succeeded` / `failed`.

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "results": [
      { "id": "session_a", "ok": true },
      { "id": "session_b", "ok": false, "error": { "code": 40401, "message": "session session_b does not exist" } }
    ],
    "succeeded": 1,
    "failed": 1
  },
  "request_id": "req_..."
}
```

### Gerenciamento de MCP (`/api/v2/mcp`)

As rotas `/api/v2/mcp/*` formam o plano unificado de gerenciamento de MCP do servidor: elas gerenciam o próprio registro de servidores MCP, independentemente de qualquer sessão — CRUD global (nível de usuário) com validação por entrada, sondagens de teste de conexão, um catálogo de inspeção endereçado por localizador, listagem de status de autenticação por servidor e todo o ciclo de vida do fluxo OAuth.

| Método e caminho | Descrição |
| --- | --- |
| `GET /api/v2/mcp/servers` | Listar todos os servidores MCP conhecidos |
| `GET /api/v2/mcp/servers/{name}` | Obter um servidor pelo nome de execução (*runtime name*) |
| `POST /api/v2/mcp/servers` | Adicionar um servidor ao `mcp.json` de nível de usuário |
| `PUT /api/v2/mcp/servers/{name}` | Substituir uma entrada de nível de usuário |
| `DELETE /api/v2/mcp/servers/{name}` | Remover uma entrada de nível de usuário |
| `POST /api/v2/mcp/servers:test` | Sondar uma conexão real com um servidor |
| `POST /api/v2/mcp/servers:inspect` | Catálogo endereçado por localizador com sondagem de conexão em lote |
| `GET /api/v2/mcp/auth-statuses` | Estado OAuth por servidor sobre o catálogo |
| `POST /api/v2/mcp/auth:begin` | Iniciar um fluxo OAuth interativo |
| `POST /api/v2/mcp/auth:complete` | Aguardar o retorno (*callback*) do navegador e finalizar a troca de código |
| `POST /api/v2/mcp/auth:cancel` | Encerrar um fluxo OAuth iniciado |
| `POST /api/v2/mcp/auth:reset` | Limpar as credenciais armazenadas de um servidor |

Dois esquemas de endereçamento aparecem neste plano. As rotas de CRUD e `servers:test` utilizam um `name` de runtime simples; as rotas de inspeção e OAuth utilizam um **localizador** (*locator*) — `{ "source": "global", "name" }` para uma entrada na camada de arquivo ou `{ "source": "plugin", "pluginId", "serverName" }` para uma entrada de manifesto de plugin — visto que uma entrada de plugin e uma entrada de arquivo podem compartilhar o mesmo nome de runtime. Os itens de inspeção carregam adicionalmente um ID de fio (*wire id*) estável `serverId`: `global:<name>` ou `plugin:<pluginId>:<serverName>` (codificado em URL).

A maioria das rotas aceita um `cwd` opcional (um parâmetro de query ou um campo de corpo nas rotas de ação `:`). Sem ele, o catálogo abrange apenas os manifestos de arquivo e de plugin de nível de usuário; com ele, as camadas de raiz de projeto e locais de projeto daquele diretório se juntam — mas apenas quando o workspace é confiável, caso contrário, as camadas de projeto são ignoradas. Para `servers:test` em um servidor stdio, o `cwd` também é o diretório de trabalho do processo filho. Sondagens de conexão e chamadas OAuth aguardam o carregamento da configuração do servidor ser concluído antes de agir.

#### `GET /api/v2/mcp/servers` e `GET /api/v2/mcp/servers/{name}`

Lista todos os servidores MCP conhecidos pelo plano de gerenciamento; a segunda rota retorna a entrada única com esse nome de runtime.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `name` | path | string | **Obrigatório (apenas para get).** Nome de execução (*runtime name*) do servidor |
| `cwd` | query | string | Incluir as camadas de projeto deste diretório (confiável) |

Em caso de sucesso, `data` é um array de servidores gerenciados (um objeto único para a rota get), cada um contendo `{ name, config, source, origin, mutable, plugin? }`:

- `source`: `global` (uma camada de arquivo de configuração) ou `plugin` (manifesto de plugin)
- `origin`: onde a entrada está definida — um caminho de arquivo ou um ID de plugin
- `mutable`: apenas entradas de nível de usuário são mutáveis; entradas de plugin e de camada de projeto são somente leitura
- `config`: entradas mutáveis carregam a configuração completa para que UIs de edição possam pré-preenchê-la; entradas somente leitura são redigidas para listas de chaves ordenadas (`envKeys` / `headerKeys`) e nunca revelam valores secretos
- `plugin`: `{ id, name }`, presente em entradas de plugin

- `40001`: falha de validação
- `40408`: nenhum servidor com esse nome

#### `POST` / `PUT` / `DELETE /api/v2/mcp/servers`

CRUD global contra o arquivo `mcp.json` de nível de usuário. O corpo de adição é uma configuração completa de servidor incluindo `name` — `transport` (`stdio` / `http` / `sse`) discrimina a estrutura, e cada entrada é validada antes de ser escrita. O corpo de atualização carrega a mesma configuração sem `name` (o caminho nomeia a entrada); a exclusão não leva corpo. Todos os três retornam a lista de servidores atualizada em `data`. Uma gravação cujo nome colida com uma entrada de camada de projeto é rejeitada como somente leitura — edite o arquivo definidor em vez disso; uma entrada de plugin com o mesmo nome não bloqueia a gravação, e a nova entrada de arquivo a oculta (*shadows*).

- `40001`: falha de validação ou a entrada de destino é somente leitura
- `40408`: (atualização/exclusão) nenhum servidor com esse nome

#### `POST /api/v2/mcp/servers:test`

Sonda uma conexão real com um servidor sem persistir nada. Passe `name` para testar uma entrada de registro (incluindo plugin e camadas de projeto confiáveis) ou `server` (uma configuração inline completa, incluindo `name`) para sondá-la tal como está; passar ambos ou nenhum resulta em falha `40001`.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `name` | body | string | Nome de execução de uma entrada de registro |
| `server` | body | object | Configuração inline de servidor para sondar tal como está |
| `cwd` | body | string | Camadas de projeto se juntam à resolução; também o diretório de trabalho stdio |

Em caso de sucesso, `data` é `{ success, output }`: quando a conexão é bem-sucedida, `output` lista as ferramentas disponíveis do servidor; caso contrário, carrega o texto da falha.

- `40001`: ambas ou nenhuma forma de destino passada, configuração inline inválida ou nome de runtime compartilhado por múltiplos servidores habilitados
- `40408`: nenhum servidor com esse nome

#### `POST /api/v2/mcp/servers:inspect`

O catálogo endereçado por localizador (configurações redigidas) mais uma sondagem em lote de conexão real de cada candidato OAuth.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `targets` | body | array | Localizadores restringindo o catálogo; omitido inspeciona todos os servidores |
| `cwd` | body | string | Incluir as camadas de projeto deste diretório (confiável) |

Em caso de sucesso, `data` é um array de inspeções, cada uma contendo `{ serverId, locator, runtimeName, canonicalUrl?, origin, config, enabled, editable, authStatus, checkedAt?, error? }`: `canonicalUrl` é a URL de credencial de um servidor remoto, `config` é a visão redigida e `authStatus` é um dentre `not-applicable` / `bearer-token` / `oauth-required` / `oauth-authorized` / `oauth-expired` / `unavailable`. Um nome de runtime compartilhado por múltiplos servidores habilitados não pode ser sondado de forma ambígua e relata `unavailable` com um `error` explicativo. Uma sondagem que encontra uma concessão expirada pode atualizar ou invalidar as credenciais armazenadas.

- `40001`: falha de validação
- `40408`: um localizador em `targets` não corresponde a nada

#### `GET /api/v2/mcp/auth-statuses`

Estado OAuth por servidor sobre o catálogo de registro — a alternativa leve ao `servers:inspect` quando apenas a dimensão de autenticação é necessária.

| Parâmetro | Em | Tipo | Descrição |
| --- | --- | --- | --- |
| `cwd` | query | string | Incluir as camadas de projeto deste diretório (confiável) |
| `verify` | query | string | `true` sonda cada candidato OAuth através de uma conexão real; `false` é totalmente offline (apenas configuração e tokens armazenados); omitido preserva a detecção OAuth implícita, sondando apenas servidores remotos não fixados (*unpinned*) sem credenciais armazenadas |

Em caso de sucesso, `data` é um array de `{ name, authStatus }` com o mesmo enum `authStatus` de `servers:inspect`. Sondagens de verificação podem atualizar ou invalidar credenciais armazenadas.

#### `POST /api/v2/mcp/auth:begin` / `:complete` / `:cancel` / `:reset`

O ciclo de vida do fluxo OAuth para servidores remotos. `auth:begin` recebe um corpo de localizador (mais a query opcional `cwd`) e responde com `data` `{ status: "authorization-required", flowId, authorizationUrl }` — abra a URL em um navegador para conceder acesso — ou `{ status: "already-authorized" }` quando uma concessão já existe. O servidor de destino deve usar um transporte remoto (`http` / `sse`) e não deve carregar um token de portador estático; cabeçalhos estáticos são permitidos apenas quando a configuração define explicitamente `auth: "oauth"`.

`auth:complete` aguarda o retorno (*callback*) do navegador de um fluxo iniciado e conclui a troca de código. Seu corpo é `{ flowId, timeoutMs? }`: a espera padrão é de 15 minutos (`timeoutMs` a substitui), um fluxo ocioso expira após 15 minutos de qualquer forma, e fechar a conexão HTTP aborta a espera. `data` é `null` em caso de sucesso.

`auth:cancel` encerra um fluxo iniciado (`{ flowId }`) sem concluí-lo; fluxos desconhecidos são ignorados. `auth:reset` recebe um corpo de localizador e limpa as credenciais armazenadas do servidor — o evento de invalidação alcança sessões ativas.

- `40001`: falha de validação — incluindo um `flowId` desconhecido em `:complete`, ou um servidor que não pode realizar OAuth (transporte stdio, token de portador estático ou cabeçalhos estáticos sem `auth: "oauth"`) em `:begin`
- `40408`: (`:begin` / `:reset`) o localizador não corresponde a nada
- `40929`: o próprio fluxo OAuth falhou

## Protocolo WebSocket (`WebSocket protocol`)

### Conexão (`Connect`)

O único endpoint é `ws://<host>:<port>/api/v1/ws`; a autenticação ocorre na requisição de atualização (*upgrade request*) (consulte [Autenticação](#authentication) acima). Uma vez conectado, o servidor envia imediatamente `server_hello`:

```json
{
  "type": "server_hello",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "payload": {
    "ws_connection_id": "conn_01JZX4...",
    "protocol_version": 2,
    "max_event_buffer_size": 1000,
    "capabilities": { "event_batching": false, "compression": false }
  }
}
```

Observe que o servidor nunca envia batimentos cardíacos (*heartbeats*) e nunca desconecta uma conexão ociosa — keepalive e reconexão são responsabilidade do cliente.

### Quadros de controle (`Control frames`)

Os clientes enviam quadros JSON `{ "type", "id"?, "payload" }`; cada quadro de requisição recebe um reconhecimento `{ "type": "ack", "id", "code", "msg", "payload" }`, onde `code` 0 significa sucesso.

| Quadro | payload | Descrição |
| --- | --- | --- |
| `subscribe` | `{ session_ids, cursors?, agent_filter? }` | Inscrever-se em eventos de sessão; com `cursors` ({seq, epoch} por sessão), o servidor reproduz os eventos duráveis perdidos |
| `unsubscribe` | `{ session_ids }` | Cancelar inscrições em sessões |
| `subscribe_v2` | `{ session_id, transcript, transcript_since? }` | Inscrever-se em fluxos de transcrição (o único canal de transcrição); `transcript` define graus por agente |
| `unsubscribe_v2` | `{ session_id, agent_ids? }` | Desconectar fluxos de transcrição; omitir `agent_ids` significa a sessão inteira |
| `watch_fs_add` / `watch_fs_remove` | `{ session_id, paths, recursive? }` | Inscrever-se em / cancelar inscrição de notificações de alteração de arquivos (`event.fs.changed`) |
| `client_hello` | `{ client_id }` | Quadro de handshake; os campos restantes são para compatibilidade legada |

### Eventos (`Events`)

Quadros de eventos têm o formato `{ "type", "seq", "epoch"?, "volatile"?, "offset"?, "session_id"?, "timestamp", "payload" }`, onde `type` é o tipo do evento em si. Dois escopos de entrega:

- **Eventos globais**: enviados a todas as conexões estabelecidas, sem necessidade de inscrição — `session.meta.updated`, `event.session.created`, `event.session.archived`, `event.session.work_changed`, `event.session.status_changed`, `event.workspace.*`, `event.config.*`, `event.model_catalog.*`.
- **Eventos de sessão**: enviados apenas para conexões inscritas nessa sessão, sujeitos a `agent_filter`. Principais famílias:

| Família | Eventos principais |
| --- | --- |
| Turnos | `turn.started`, `turn.ended`, `turn.step.started` / `completed` / `interrupted` / `retrying` |
| Texto em streaming | `assistant.delta`, `thinking.delta` (carregam `offset` para alinhamento) |
| Chamadas de ferramenta | `tool.call.started`, `tool.call.delta`, `tool.progress`, `tool.result` |
| Interações | `event.approval.requested` / `resolved`, `event.question.requested` / `answered` / `dismissed` |
| Subagentes | `subagent.spawned` / `started` / `suspended` / `completed` / `failed` |
| Segundo plano | `task.started` / `terminated`, `shell.started` / `output` / `completed` |
| Diversos | `compaction.*`, `skill.activated`, `goal.updated`, `prompt.*`, `error`, `warning` |

Três eventos globais de ciclo de vida mantêm uma visão geral multi-workspace atualizada sem polling por workspace. `event.session.archived` é disparado tanto no caminho de arquivo ativo quanto no frio; seu envelope `session_id` é a marca d'água global `__global__` e o ID real da sessão viaja no payload: `{ "type": "event.session.archived", "workspace_id": "wd_...", "sessionId": "session_..." }` (chaves do payload `workspace_id` / `sessionId`). `event.workspace.created` / `updated` carregam o objeto de workspace completo (`{ id, root, name, created_at, last_opened_at, session_count }` — um `updated` também é disparado quando a criação de uma sessão toca o workspace), e `event.workspace.deleted` carrega `{ "workspace_id", "root" }`. Esses eventos cobrem apenas alterações feitas dentro deste processo de servidor; alterações de outros processos (por exemplo, uma CLI gravando na mesma home) aparecem por meio da reconciliação de índice (cerca de um minuto), portanto, clientes de visão geral devem manter um polling de fallback de baixa frequência. Não existe evento de exclusão de sessão.

Os eventos também se dividem em duráveis e voláteis: eventos duráveis carregam um `seq` estritamente crescente, são gravados em diário (*journaled*) e podem ser reproduzidos; eventos voláteis (a família `*.delta`, `tool.progress`, `shell.*` e similares) são marcados com `volatile: true` e nunca são reproduzidos. Ao consumir um fluxo de texto volátil, compare o `offset` (o deslocamento cumulativo de caracteres dentro do turno) com o seu texto acumulado localmente: ficar abaixo do comprimento local significa um quadro duplicado; ficar acima significa uma lacuna que requer recuperação de snapshot.

### Reconexão e recuperação (`Reconnect and recovery`)

Após a reconexão, passe o último `{seq, epoch}` aplicado de cada sessão nos `cursors` de `subscribe`; o servidor reproduz a lacuna. Se você ficar atrasado além do buffer (1000 eventos) ou se o cursor não for mais válido, você receberá `resync_required`. Nesse caso, chame `GET /api/v1/sessions/{session_id}/snapshot` para obter um snapshot completo (com `as_of_seq` e `epoch`), e então inscreva-se novamente com o cursor atualizado.

### Protocolo de transcrição (`Transcript protocol`)

O campo `transcript` de `subscribe_v2` define um grau por agente: `off` / `turn` / `block` / `delta` (a chave `"*"` define o grau padrão), com graus mais altos enviando detalhes mais refinados. Um agente com grau diferente de `off` recebe dois tipos de quadros: `transcript.reset` (um snapshot de linha de base; páginas de histórico chegam via REST) e `transcript.ops` (lotes de operações incrementais com um `seq` estritamente crescente por agente). Os eventos legados do agente são suprimidos nessa conexão e transportados por quadros de transcrição. Após uma desconexão, retome com `transcript_since`; quando o diário de operações do servidor não puder cobrir a lacuna (a recuperação via REST retorna `complete: false`), faça uma atualização completa. As contrapartes REST são `GET .../transcript` (paginado por turno) e `GET .../transcript/ops?since_seq=` (recuperação em lote de operações).

## Endpoints binários e de streaming (`Binary and streaming endpoints`)

Os seguintes endpoints transmitem corpos binários em vez de um payload JSON. Suas capacidades HTTP diferem por endpoint:

| Método e caminho | Descrição | Range (206) | ETag / 304 |
| --- | --- | --- | --- |
| `GET /api/v1/files/{file_id}` | Baixar um arquivo enviado | Sim | Não (envia um cabeçalho `etag`, mas ignora `If-None-Match`) |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | Baixar um arquivo de workspace de sessão | Sim | Sim |
| `GET /api/v1/fs:content` | Bytes brutos de qualquer arquivo do host (protegido apenas pelo token — cuidado ao expor a porta) | Sim | Sim |
| `POST /api/v1/sessions/{session_id}/export` | Exportar a sessão com diagnósticos (fluxo zip) | Não | Não |

A semântica de erros também difere: `GET /api/v1/files/{file_id}` responde a falhas de busca e armazenamento com status reais 404 / 500 (a validação de parâmetros ainda usa o envelope HTTP 200), enquanto os outros três relatam cada falha por meio do [envelope de resposta padrão](#response-envelope) — os clientes devem continuar verificando o `code` do envelope nesses endpoints.

## Próximos passos (`Next steps`)

- [Usando o Kimi Code no navegador](../guides/web.md) — inicie o servidor e use o Kimi Code em um navegador