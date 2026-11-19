# Comando `kimi`

O `kimi` é o comando principal da CLI do Kimi Code, usado para iniciar uma sessão interativa no terminal. Executá-lo sem argumentos abre uma nova sessão no diretório de trabalho atual; combinado com diferentes flags, você pode retomar uma sessão anterior, ignorar aprovações, iniciar no modo Plano (Plan) ou carregar Skills de um diretório personalizado.

```
kimi [options]
kimi <subcommand> [options]

```

## Opções Principais do Comando

Todas as flags são opcionais — execute `kimi` diretamente para entrar em uma sessão interativa:

| Opção | Atalho | Descrição | 
| ----- | ----- | ----- | 
| `--version` | `-V` | Exibe o número da versão e sai | 
| `--help` | `-h` | Exibe informações de ajuda e sai | 
| `--session [id]` | `-S` | Retoma uma sessão. Com um ID, abre essa sessão diretamente; sem um ID, entra em um seletor interativo | 
| `--continue` | `-c` | Continua a sessão mais recente no diretório de trabalho atual, sem precisar especificar um ID manualmente | 
| `--model <model>` | `-m` | Especifica um alias de modelo para esta inicialização. Quando omitido, novas sessões usam o `default_model` do arquivo de configuração | 
| `--prompt <prompt>` | `-p` | Executa um único prompt de forma não interativa e transmite a saída do Assistente para o stdout. Este modo não abre a TUI | 
| `--output-format <format>` |  | Define o formato de saída não interativo; suporta `text` e `stream-json`. Só pode ser usado com `--prompt`; o padrão é `text` | 
| `--yolo` | `-y` | Inicia no modo Perguntar Quando Necessário (Ask When Needed): edições rotineiras e comandos rodam automaticamente; ações arriscadas, perguntas e planos ainda exigem confirmação | 
| `--auto` |  | Inicia no modo Nunca Perguntar (Never Ask): nunca o interrompe; tudo roda e é decidido automaticamente | 
| `--plan` |  | Inicia uma nova sessão no modo Plano (Plan) — a IA priorizará ferramentas somente leitura para exploração e planejamento | 
| `--skills-dir <dir>` |  | Carrega Skills do diretório especificado, substituindo os diretórios de usuário e de projeto descobertos automaticamente. Pode ser repetido | 
| `--agent <name>` |  | Inicia uma nova sessão com o agente especificado como o Agente principal. Não pode ser combinado com `--session`/`--continue` | 
| `--agent-file <path>` |  | Carrega um agente personalizado a partir de um arquivo Markdown para a nova sessão e o seleciona. Não pode ser repetido ou combinado com `--agent`, `--session` ou `--continue` | 
| `--add-dir <dir>` |  | Adiciona um diretório de workspace extra para esta sessão. Caminhos relativos são resolvidos em relação ao diretório de trabalho atual. Pode ser repetido | 

`-r` / `--resume` é um alias oculto para `--session`; `--yes` e `--auto-approve` são aliases ocultos para `--yolo` e não aparecem na saída de ajuda.

::: warning
O `--yolo` ignora a aprovação humana para chamadas de ferramentas regulares, incluindo gravações de arquivos e execução de comandos de shell. Use-o apenas em diretórios de trabalho confiáveis. A aprovação de saída do modo Plano não é ignorada pelo `--yolo`; o `Bash` dentro do modo Plano é tratado sob as regras normais de permissão.
:::

### Regras de Conflito de Flags

As seguintes combinações são rejeitadas na inicialização:

* `--continue` e `--session` são mutuamente exclusivas — ambas significam "retomar uma sessão anterior"

* `--yolo` e `--auto` são mutuamente exclusivas — os dois modos de permissão não podem ser combinados

* `--prompt` não pode ser usado com `--yolo`, `--auto` ou `--plan` — o modo não interativo usa a permissão `auto` por padrão

* `--output-format` só pode ser usado em conjunto com `--prompt`

Ao retomar uma sessão, você pode substituir a permissão salva ou o modo plano adicionando `--auto`, `--yolo` ou `--plan`. Por exemplo, `kimi --continue --auto` retoma a última sessão e a alterna para o modo Nunca Perguntar.

## Uso Comum

Iniciar uma nova sessão diretamente:

```
kimi

```

Continuar de onde você parou (encontra automaticamente a sessão mais recente no diretório atual):

```
kimi --continue

```

Escolher da lista de histórico de sessões ou especificar um ID conhecido diretamente:

```
kimi --session
kimi --session 01HZ...XYZ

```

Ignorar prompts de aprovação — adequado para tarefas em lote que são comprovadamente seguras:

```
kimi --yolo

```

Deixar o Agente lidar com tudo de forma autônoma, sem fazer perguntas ao usuário:

```
kimi --auto

```

Ler o código e produzir um plano de implementação antes de fazer qualquer alteração em arquivos:

```
kimi --plan

```

### Diretórios de Skills Personalizados

Existem duas maneiras de especificar diretórios de Skills, com semânticas diferentes:

* **`--skills-dir <dir>`** (flag de CLI): **Substitui** os diretórios de usuário e de projeto descobertos automaticamente apenas para esta inicialização. Pode ser repetido para empilhar vários diretórios:

  ```
  kimi --skills-dir /path/to/team-skills --skills-dir ./local-skills
  
  ```

* **`extra_skill_dirs`** (`config.toml`): **Adiciona** diretórios além daqueles descobertos automaticamente, aplicando-se de forma permanente. Adequado para configurar Skills compartilhadas pela equipe. Consulte [Agent Skills](../customization/skills.md).

### Agentes Personalizados

`--agent` e `--agent-file` selecionam qual agente conduz uma nova sessão, tanto no modo de impressão (`kimi -p`) quanto na TUI interativa:

```
kimi --agent reviewer
kimi -p --agent reviewer "Review the changes on this branch"

```

O `--agent-file` registra um único arquivo de agente com a mais alta prioridade apenas para esta inicialização e o seleciona; a flag não pode ser repetida, e `--agent` e `--agent-file` são mutuamente exclusivos. Ambas as flags só se aplicam ao iniciar uma nova sessão — nenhuma delas pode ser combinada com `--session`/`--continue`, porque o agente é vinculado na criação da sessão e a retomada restaura o agente vinculado automaticamente. A seleção é fixa no primeiro vínculo da sessão e não pode ser alterada posteriormente; na TUI, as flags vinculam apenas a sessão de inicialização, e uma sessão criada posteriormente no mesmo processo (por exemplo, via `/new`) inicia com o agente padrão. Consulte [Agentes e Subagentes](../customization/agents.md#custom-agents) para conhecer o formato do arquivo de agente e os diretórios de descoberta.

## Execução Não Interativa

Ao executar um único prompt em um script ou ambiente de CI, use `-p`:

```
kimi -p "Summarize the current repository status"

```

A saída usa um estilo de transcrição: o conteúdo de raciocínio (thinking) e o texto do Assistente recebem o prefixo `• `, e as linhas quebradas são recuadas por dois espaços. O texto do Assistente vai para o stdout; o raciocínio, o progresso de ferramentas e os avisos de "retomando sessão" vão para o stderr. No modo `-p`, nenhuma aprovação humana é solicitada — chamadas de ferramentas regulares são tratadas sob a política de permissão `auto`, enquanto as regras de negação estática continuam em vigor.

Alternar temporariamente o modelo:

```
kimi -m kimi-code/kimi-for-coding -p "Explain the latest diff"

```

Quando precisar analisar a saída programaticamente, use o formato `stream-json` — cada linha no stdout é um objeto JSON:

```
kimi -p "List changed files" --output-format stream-json

```

No modo `stream-json`, respostas regulares produzem uma mensagem do Assistente; quando o modelo chama uma ferramenta, uma mensagem do Assistente com `tool_calls` é emitida primeiro, seguida pela mensagem da Ferramenta correspondente e, em seguida, pelas mensagens subsequentes do Assistente. O conteúdo de raciocínio não é gravado no JSONL; o progresso de ferramentas e os avisos de "retomando sessão" ainda são gravados no stderr.

## Subcomandos

O `kimi` fornece os seguintes subcomandos: `login` (login não interativo), `acp` (modo ACP IDE), `web` (executa o serviço local REST/WebSocket/web em primeiro plano e abre a interface web), `doctor` (valida arquivos de configuração), `export` (exporta uma sessão), `migrate` (migra dados legados), `upgrade` (verifica atualizações) e `provider` (gerencia provedores).

### `kimi login`

Faz login no OAuth do Kimi Code por meio do fluxo de código de dispositivo RFC 8628, sem entrar na TUI. O comando emite uma solicitação de autorização de dispositivo, imprime a URL de verificação e o código de usuário no stderr e faz polling até que a autorização no navegador seja concluída. O token gerado é gravado no mesmo local local do `/login` da TUI e é carregado automaticamente na próxima vez que o `kimi` iniciar.

```
kimi login

```

Este subcomando não possui flags. Pressione `Ctrl-C` a qualquer momento durante o polling para cancelar; o código de saída é `1` em caso de cancelamento ou falha, e `0` em caso de sucesso.

### `kimi acp`

Alterna a CLI do Kimi Code para o modo ACP (Agent Client Protocol), comunicando-se com uma IDE via JSON-RPC sobre stdin/stdout para que o editor possa conduzir diretamente as sessões e chamadas de ferramentas do kimi. Geralmente você não precisa executar isso manualmente — a IDE o inicia como um ponto de entrada de subprocesso. Para configuração, consulte [Uso em IDEs](../guides/ides.md); para detalhes técnicos, consulte a [referência do kimi acp](./kimi-acp.md).

```
kimi acp

```

### `kimi web`

Executa o servidor local do Kimi em primeiro plano no terminal atual — um único processo que expõe a API REST + WebSocket e serve a interface web a partir da mesma origem — e abre a interface web no navegador padrão assim que estiver pronta. O comando permanece anexado ao terminal e é encerrado limpamete com `SIGINT` / `SIGTERM` (por exemplo, `Ctrl-C`).

Quando o servidor está em execução, `GET /openapi.json` retorna o documento REST OpenAPI e `GET /asyncapi.json` retorna o documento WebSocket AsyncAPI local. Para um passo a passo completo sobre como conduzir sessões pela API, consulte [API de Servidor: Conduza uma sessão pela API](./server-api.md#drive-a-session-over-the-api); para detalhes do protocolo, consulte a referência da [API de Servidor](./server-api.md).

```
kimi web                # executa o servidor em primeiro plano e abre o navegador
kimi web --no-open      # não abre o navegador
kimi web --port 58628   # escolhe uma porta de vínculo específica

```

Múltiplas instâncias podem compartilhar um diretório home: cada uma se registra sob `~/.kimi-code/server/instances/`, e uma porta ocupada é tentada novamente com `port + 1` (58628, 58629, …).

| Opção | Descrição | 
| ----- | ----- | 
| `--port <port>` | Porta de vínculo; o padrão é `58627`; uma porta ocupada é tentada novamente com `+1` | 
| `--host [host]` | Host de vínculo; omita para `127.0.0.1` (apenas esta máquina), passe um `--host` vazio para `0.0.0.0` (todas as interfaces) | 
| `--allowed-host <host...>` | Valores extras de cabeçalho Host permitidos através da verificação de DNS-rebinding; repetível ou separado por vírgulas | 
| `--log-level <level>` | Ativa logs do servidor no nível selecionado; omitido por padrão | 
| `--debug-endpoints` | Monta rotas `/api/v1/debug/*` (desativado por padrão) | 
| `--dangerous-bypass-auth` | Desativa a autenticação por token bearer em todas as rotas REST e WebSocket para que a interface web se conecte sem token; apenas para redes confiáveis ou atrás de um proxy de autenticação | 
| `--web-title <title>` | Título personalizado da aba do navegador para a interface web; o padrão é o nome do diretório do workspace | 
| `--no-open` | Não abre o navegador assim que o servidor estiver pronto | 

O `kimi web` se vincula apenas ao loopback local por padrão e imprime o token bearer no banner de inicialização; a interface web se autentica automaticamente através do fragmento de URL `#token=`.

::: info
A árvore de comandos `kimi server` está obsoleta: qualquer invocação de `kimi server …` (incluindo todos os subcomandos legados) apenas imprime um aviso de descontinuação e sai com o código 1 — use `kimi web` em vez disso. A única exceção é `kimi server kill`, que continua funcional para parar servidores iniciados por uma versão anterior à 0.28.0. O aviso será removido na próxima versão principal do Kimi Code.
:::

::: danger
O `--dangerous-bypass-auth` desativa a autenticação completamente. Qualquer pessoa que alcançar a porta terá acesso total às suas sessões, sistema de arquivos e shell. Use-o apenas em uma rede confiável ou atrás de seu próprio proxy reverso de autenticação, e pare o servidor com `Ctrl+C` quando terminar.
:::

#### `kimi server kill`

Obsoleto — para apenas um servidor iniciado por uma versão anterior à 0.28.0. Essas versões podiam deixar um servidor em segundo plano para trás, registrado no bloqueio de instância única legado em `~/.kimi-code/server/lock`; o comando tenta primeiro `POST /api/v1/shutdown` para uma saída graciosa, depois sinaliza o PID registrado com SIGTERM, escalando para SIGKILL quando necessário, e remove o arquivo de bloqueio assim que o processo é confirmado como morto. Servidores iniciados por `kimi web` rodam em primeiro plano — pare-os com `Ctrl+C` em vez disso.

#### `kimi web rotate-token`

Gera um novo token bearer persistente (gravado em `~/.kimi-code/server.token`); o token anterior para de funcionar imediatamente. O token é compartilhado por todo o diretório home, portanto, cada instância em execução pega o novo em sua próxima verificação de autenticação — sem necessidade de reinicialização.

### `kimi install-desktop`

Exibe a página do aplicativo desktop do Kimi Code e a abre no navegador padrão, para que você possa baixar e instalar o aplicativo desktop sem sair do terminal. A URL segue a região ativa: `https://www.kimi.com/code` na região da China continental, `https://www.kimi.ai/code` na região global.

```
kimi install-desktop

```

Este subcomando não possui flags. O nome anterior, `kimi install-app`, ainda funciona como um alias oculto. A mesma página também pode ser acessada a partir da TUI com o comando slash `/desktop` (alias `/install-desktop`).

### `kimi doctor`

Valida `config.toml` e `tui.toml` sem iniciar a TUI ou modificar qualquer um dos arquivos. Por padrão, o comando verifica os arquivos em `KIMI_CODE_HOME` (ou `~/.kimi-code` quando a variável de ambiente não estiver definida). Arquivos padrão ausentes são relatados como ignorados porque os padrões embutidos podem ser aplicados.

```
kimi doctor

```

| Comando | Descrição | 
| ----- | ----- | 
| `kimi doctor` | Valida o `config.toml` e o `tui.toml` padrão | 
| `kimi doctor config [path]` | Valida apenas o `config.toml`, usando `path` em vez do arquivo padrão quando fornecido | 
| `kimi doctor tui [path]` | Valida apenas o `tui.toml`, usando `path` em vez do arquivo padrão quando fornecido | 

Quando um caminho explícito é passado, o arquivo deve existir. O comando sai com `0` quando todos os arquivos verificados são válidos ou ignorados, e `1` quando qualquer arquivo solicitado está ausente ou inválido.

```
# Verificar os arquivos de configuração padrão
kimi doctor

# Verificar apenas a configuração de tempo de execução padrão
kimi doctor config

# Verificar uma configuração candidata de TUI antes de substituir a configuração ativa
kimi doctor tui ./tui.toml

```

### `kimi export`

Empacota uma sessão em um arquivo ZIP para compartilhamento, arquivamento ou envio de relatórios de bugs.

```
kimi export [sessionId] [options]

```

| Parâmetro / Opção | Atalho | Descrição | 
| ----- | ----- | ----- | 
| `sessionId` |  | O ID da sessão a ser exportada. Quando omitido, a sessão mais recente no diretório de trabalho atual é selecionada automaticamente e requer confirmação | 
| `--output <path>` | `-o` | Caminho do arquivo ZIP de saída. Quando omitido, grava em um nome de arquivo padrão no diretório atual | 
| `--yes` | `-y` | Ignora o prompt de confirmação para a sessão padrão e exporta diretamente | 
| `--no-include-global-log` |  | Não inclui o log de diagnóstico global. Incluído por padrão | 

A exportação contém todos os arquivos no diretório da sessão de destino. O log de diagnóstico global (`~/.kimi-code/logs/kimi-code.log`) é incluído por padrão porque pode conter eventos de outras sessões ou projetos; adicione `--no-include-global-log` se não quiser compartilhá-lo.

```
# Exportar a sessão mais recente no diretório atual, ignorando a confirmação
kimi export -y

# Exportar uma sessão específica para um caminho personalizado
kimi export 01HZ...XYZ -o ./bug-report.zip

# Excluir o log de diagnóstico global
kimi export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log

```

### `kimi migrate`

Migra dados locais de uma instalação legada do kimi-cli para o kimi-code, incluindo histórico de sessões e arquivos de configuração. É executado de forma totalmente interativa, guiando você por todo o processo.

```
kimi migrate

```

Para instruções completas de migração, consulte [Migrando do kimi-cli](../guides/migration.md).

### `kimi upgrade`

Verifica imediatamente se há a versão mais recente e exibe um prompt de atualização; sai após você fazer uma seleção. `kimi update` é um alias para este comando.

```
kimi upgrade [-y]

```

Para instalações globais via npm, pnpm, yarn e bun, o `kimi upgrade` mostra opções de atualização; selecionar `Install update now` executa o comando de instalação correspondente em primeiro plano. Para instalações nativas (incluindo Windows), ele baixa e verifica o novo binário em primeiro plano e o substitui na próxima inicialização. Quando o método de instalação atual não puder ser atualizado automaticamente, o comando de atualização manual será exibido em vez disso. Passe `-y, --yes` para ignorar o prompt de confirmação e instalar a atualização diretamente.

### `kimi vis`

Inicia o visualizador de sessões em seu navegador para inspecionar uma sessão à medida que ela se desenrola. O comando inicia um servidor em processo apontado para suas sessões locais, imprime a URL, abre seu navegador e continua rodando até que você pressione `Ctrl-C`.

```
kimi vis [sessionId] [options]

```

| Parâmetro / Opção | Descrição | 
| ----- | ----- | 
| `sessionId` | Abre o visualizador diretamente nesta sessão. Quando omitido, abre a visualização inicial listando suas sessões | 
| `--port <number>` | Porta para escuta. Por padrão, uma porta disponível é escolhida automaticamente | 
| `--host <host>` | Host para escuta. Padrão: `127.0.0.1` | 
| `--no-open` | Não abre o navegador automaticamente; apenas imprime a URL | 

```
# Iniciar o visualizador e abrir o navegador na visualização inicial
kimi vis

# Abrir diretamente em uma sessão específica
kimi vis 01HZ...XYZ

# Vincular uma porta e host fixos sem abrir o navegador (por exemplo, em um host remoto)
kimi vis --host 0.0.0.0 --port 8123 --no-open

```

### `kimi provider`

Gerencia provedores no shell — o equivalente não interativo de `/provider` na TUI. Adequado para implantações via script, inicialização de CI e configuração de linha única em uma máquina nova.

```
kimi provider <action> [options]

```

Cinco ações estão disponíveis:

#### `kimi provider add <url>`

Importa em lote todos os provedores de um registro personalizado (`api.json`). O comando busca o registro, cria uma entrada `[providers.<id>]` e `[models.<alias>]` para cada item e grava metadados de `source` para que a TUI atualize os provedores e modelos a partir da mesma URL de registro automaticamente na próxima inicialização. Quando uma entrada de registro declara o campo `env`, o comando imprime uma dica nomeando a variável declarada — defina `api_key_env` no `config.toml` para usá-la; consulte [Provedores e modelos](../configuration/providers.md).

| Parâmetro / Opção | Descrição | 
| ----- | ----- | 
| `<url>` | URL do registro | 
| `--api-key <key>` | Token Bearer para acessar o registro. Recorre à variável de ambiente `KIMI_REGISTRY_API_KEY` se não for fornecida; opcional — omita ambas para registros públicos | 

```
kimi provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# Ou via variável de ambiente (adequado para CI / .envrc)
KIMI_REGISTRY_API_KEY=YOUR_KEY kimi provider add https://registry.example.com/v1/models/api.json

# Registro público: nenhuma chave necessária
kimi provider add https://registry.example.com/v1/models/api.json

```

Se um ID de provedor já existir, ele será removido e recriado. O modelo padrão não é definido automaticamente; você pode selecionar um posteriormente com `-m` ou `/model` na TUI.

#### `kimi provider remove <providerId>`

Remove o provedor especificado e todos os seus aliases de modelo. Se o provedor removido for o referenciado por `default_model`, o `default_model` também será limpo.

```
kimi provider remove kohub

```

#### `kimi provider list`

Imprime cada provedor configurado em uma linha separada, incluindo tipo, contagem de modelos e fonte. Adicione `--json` para gerar as tabelas brutas de `providers` e `models` para processamento programático.

```
kimi provider list
kimi provider list --json | jq '.providers | keys'

```

#### `kimi provider catalog list [providerId]`

Navega pelo catálogo público de modelos [models.dev](https://models.dev/) sem modificar nenhuma configuração. Sem um argumento, lista todos os provedores juntamente com seu tipo de protocolo e contagem de modelos; com um `providerId`, lista todos os modelos sob esse provedor juntamente com sua janela de contexto e capacidades. Se a URL do catálogo não puder ser alcançada, um snapshot embutido do catálogo será usado em vez disso.

| Parâmetro / Opção | Descrição | 
| ----- | ----- | 
| `[providerId]` | Opcional — o ID do provedor a ser inspecionado | 
| `--filter <substring>` | Filtro de substring (maiúsculas/minúsculas ignoradas) em ID ou nome | 
| `--url <url>` | Substitui a URL do catálogo; o padrão é `https://models.dev/api.json` | 
| `--json` | Gera as entradas correspondentes como JSON | 

```
kimi provider catalog list
kimi provider catalog list --filter anthropic
kimi provider catalog list anthropic

```

#### `kimi provider catalog add <providerId>`

Importa um provedor conhecido diretamente do catálogo por ID. O tipo de protocolo, a URL base e as informações do modelo são fornecidos pelo catálogo — apenas uma chave de API é necessária. Fornecedores cujo protocolo o catálogo não declara (por exemplo, xai, openrouter e outros SDKs específicos de fornecedores) são importados como compatíveis com OpenAI e a saída observa o palpite; quando o catálogo não fornece nenhum endpoint utilizável, `--base-url` é obrigatório. Protocolos proprietários (por exemplo, Amazon Bedrock) não podem ser importados. Quando o catálogo público estiver inacessível, a importação usa o snapshot embutido, funcionando offline ou em redes bloqueadas.

| Parâmetro / Opção | Descrição | 
| ----- | ----- | 
| `<providerId>` | ID do provedor no catálogo, por exemplo, `anthropic`, `openai` | 
| `--api-key <key>` | Chave de API do provedor. Recorre a `KIMI_REGISTRY_API_KEY` se não for fornecida; obrigatório | 
| `--default-model <modelId>` | Opcional — define `default_model` para `<providerId>/<modelId>` após a importação | 
| `--base-url <url>` | Substitui o endpoint do catálogo; obrigatório quando o catálogo não declara nenhum (ou apenas um espaço reservado de ambiente) | 
| `--url <url>` | Substitui a URL do catálogo; o padrão é `https://models.dev/api.json` | 

```
kimi provider catalog list anthropic          # Procurar modelos disponíveis primeiro
kimi provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7

```

## Próximos passos

* [Comandos Slash](./slash-commands.md) — Referência rápida para comandos de controle na TUI interativa

* [Arquivos de Configuração](../configuration/config-files.md) — Configuração persistente para `default_model`, modo de permissão e outros parâmetros de inicialização

* [Agent Skills](../customization/skills.md) — Formato de arquivo de Skill para diretórios carregados via `--skills-dir`

* [Agentes e Subagentes](../configuration/agents.md) — Subagentes integrados, arquivos de agentes personalizados e seleção do Agente principal via `--agent`