# Plugins

Os plugins encapsulam funcionalidades reutilizáveis ​​da Kimi Code CLI em unidades instaláveis: eles podem adicionar [Habilidades de Agente](./skills.md) e [agentes](./agents.md) personalizados, carregar automaticamente uma Habilidade específica ao iniciar a sessão, fornecer instruções de system prompt e declarar servidores MCP para disponibilizar recursos reais de ferramentas. São ideais para compartilhar fluxos de trabalho com uma equipe, conectar-se a serviços externos ou instalar extensões a partir dos [plugins oficiais](#official-plugins).

## Instalação e Gerenciamento

Execute `/plugins` na TUI para abrir o gerenciador de plugins. Trata-se de um painel único com quatro abas, alternáveis ​​com `Tab` / `Shift-Tab`:

- **Installed**: Gerencie plugins instalados
- **Official**: Plugins do marketplace mantidos pela Kimi
- **Curated**: Plugins de terceiros (parceiros da Kimi) no marketplace padrão
- **Custom**: Instale a partir de uma URL

Teclas comuns:

| Tecla | Ação |
| --- | --- |
| `Tab` / `Shift-Tab` | Alternar entre as abas Installed / Official / Curated / Custom tabs |
| `Espaço` | Habilitar ou desabilitar o plugin instalado selecionado (aba Installed) |
| `D` | Remover o plugin instalado selecionado (aba Installed) |
| `M` | Gerenciar servidores MCP para o plugin selecionado (aba Installed) |
| `R` | Recarregar `installed.json` e todos os manifestos (aba Installed) |
| `Enter` | Installed: atualizar se disponível ou ver detalhes · Official/Curated: instalar ou atualizar · Custom: instalar |
| `I` | Ver detalhes do plugin (aba Installed) |
| `Esc` | Voltar ou cancelar |

Você também pode usar comandos de barra diretamente:

| Comando | Descrição |
| --- | --- |
| `/plugins` | Abre o gerenciador de plugins interativo |
| `/plugins list` | Lista os plugins instalados |
| `/plugins install <caminho-ou-url>` | Instala a partir de um diretório local, URL de arquivo zip ou URL de repositório do GitHub |
| `/plugins marketplace [fonte]` | Navega pelo marketplace oficial ou fornece um caminho ou URL de JSON de marketplace personalizado |
| `/plugins info <id>` | Exibe detalhes e diagnósticos do plugin |
| `/plugins enable <id>` | Habilita um plugin |
| `/plugins disable <id>` | Desabilita um plugin |
| `/plugins remove <id>` | Remove um plugin (requer confirmação) |
| `/plugins reload` | Recarrega o `installed.json` e todos os manifestos de plugins |
| `/plugins mcp enable <id> <servidor>` | Habilita um servidor MCP declarado por um plugin |
| `/plugins mcp disable <id> <servidor>` | Desabilita um servidor MCP declarado por um plugin |

### Instalação a partir do GitHub

Use `/plugins install <url>` para instalar diretamente de um repositório do GitHub. Quatro formatos de URL são suportados:

- `https://github.com/<owner>/<repo>`: Instala a versão mais recente (release); utiliza a branch padrão caso não exista nenhuma versão
- `https://github.com/<owner>/<repo>/tree/<ref>`: Instala uma branch, tag ou SHA de commit (abreviado) específica
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`: Fixa a instalação em uma tag específica
- `https://github.com/<owner>/<repo>/commit/<sha>`: Fixa a instalação em um commit específico

As requisições de rede passam apenas por redirecionamentos do `github.com` e downloads do `codeload.github.com`; o `api.github.com` não é acionado.

### Notas

- As alterações nos plugins entram em vigor após o comando `/reload` ou em novas sessões. Após instalar, ativar/desativar ou remover um plugin, execute `/reload` ou `/new`; a sessão atual não será atualizada.
- As instalações locais são copiadas para `$KIMI_CODE_HOME/plugins/managed/<id>/`, e a CLI sempre é executada a partir dessa cópia gerenciada. Editar o diretório de origem original após a instalação não surte efeito; é necessário reinstalar.
- A remoção de um plugin exclui apenas o registro da instalação; a cópia gerenciada e os arquivos de origem originais permanecem no disco.
- Atualmente, os plugins são instalados por usuário e aplicam-se a todos os projetos; o escopo de instalação em nível de projeto ainda não é suportado.

### JSON de marketplace personalizado

Forneça um caminho ou URL de um JSON de marketplace personalizado para `/plugins marketplace <source>` ou defina [`KIMI_CODE_PLUGIN_MARKETPLACE_URL`](../configuration/env-vars.md) para substituir o catálogo padrão. Cada entrada no array `plugins` precisa de um `id` e uma `source` (caminho local, URL de arquivo zip ou URL do GitHub):

```json
{
  "version": "2",
  "plugins": [
    {
      "id": "my-plugin",
      "displayName": "My Plugin",
      "source": "./my-plugin"
    }
  ]
}
```

## Plugins Oficiais

Plugins oficiais são plugins e recursos nativos do produto mantidos pela Kimi. Atualmente, existem três:

- **[Kimi Datasource](#kimi-datasource)**: Consulte dados do mercado financeiro, notícias financeiras, indicadores macroeconômicos, registros de empresas, literatura acadêmica, leis e regulamentações chinesas e dados oficiais de organizações intergovernamentais usando linguagem natural
- **[Kimi WebBridge](#kimi-webbridge)**: Permita que a IA controle seu navegador para realizar tarefas na web
- **[Kimi Computer Use](#kimi-computer-use)**: Permita que a IA opere seus aplicativos de desktop (macOS e Windows)

### Instalação e Atualização

Todos os plugins oficiais compartilham o mesmo fluxo de instalação e atualização:

1. Execute `/plugins` e pressione `Tab` para selecionar **Official** (Oficial)
2. Encontre o plugin desejado e pressione `Enter` para instalá-lo
3. Após a conclusão da instalação, execute `/reload` ou `/new` para ativá-lo

::: info Nota
O Kimi WebBridge é instalado em duas partes: após as etapas acima, você também precisa [instalar a extensão do navegador](#install-the-browser-extension) para que ele funcione.
:::

Os plugins oficiais não são atualizados automaticamente. Quando uma atualização estiver disponível, você receberá um aviso na próxima vez que utilizar a versão antiga. Para atualizar, repita as etapas de instalação descritas acima.

### Kimi Datasource <Badge type="tip" text="v3.4.0" />

O Kimi Datasource é o plugin de dados oficial do Kimi Code, permitindo consultar dados do mercado financeiro, notícias financeiras, indicadores macroeconômicos, registros corporativos, literatura acadêmica, leis e regulamentações chinesas e dados oficiais de organizações intergovernamentais utilizando linguagem natural. Não são necessárias chamadas manuais de API ou contas de dados específicas.

As fontes incluem instituições de referência e bases de dados líderes, como Banco Mundial, FMI, OCDE, FRED, OMS, FAO, Escritório Nacional de Estatísticas da China, Wind, S&P Capital IQ, SEC EDGAR, Caixin, Xinhua Finance e Hundsun Juyuan, todas com rastreabilidade até os seus editores originais.

Primeiro, você deve realizar o login via OAuth com uma conta Kimi Code através de `/login`; as consultas de dados consomem a cota do seu plano Kimi Code.

#### Como usar

1. Descreva sua necessidade em linguagem natural, e o Kimi Code invocará automaticamente os recursos de dados
2. Acione explicitamente a função de consulta de dados com `/skill:kimi-datasource`

#### O que você pode fazer

::: details **Pesquisa de mercado em tempo real** — Quer realizar uma análise quantitativa de uma ação?
Obtenha dados de três anos de preços de fechamento diários e sinais de MACD e KDJ em uma única consulta, sem precisar de plataformas de dados de terceiros.
:::

::: details **Comparação macroeconômica entre países** — Está estudando as mudanças nas cadeias de suprimentos na China, Índia e Vietnã?
Obtenha séries temporais completas de crescimento do PIB, volume comercial e dados demográficos de vários países, com base em informações do Banco Mundial abrangendo mais de 50 anos, tudo de uma só vez.
:::

::: details **Análise de risco pré-contratual** — Precisa avaliar uma contraparte minutos antes de assinar um contrato?
Digite o nome da empresa e obtenha instantaneamente informações sobre registro empresarial, estrutura societária, disputas judiciais e situação em listas negras de crédito, exatamente quando precisar.
:::

::: details **Aceleração da revisão de literatura** — Está mapeando a evolução da pesquisa sobre RLHF para um artigo?
Encontre os artigos mais citados, os principais autores e as descobertas fundamentais em segundos, permitindo que o esboço da sua revisão de literatura ganhe forma na metade do tempo.
:::

::: details **Consulta jurídica imediata** — Precisa confirmar a legislação referente a uma disputa contratual sobre direitos de residência?
Localize os artigos relevantes do Código Civil (texto integral, hierarquia normativa e vigência) em uma única consulta e obtenha precedentes comparáveis ​​para fundamentar a análise, sem precisar vasculhar bancos de dados legislativos.
:::

::: details **Análise de ações dos EUA com padrão institucional** — Está elaborando uma análise aprofundada de uma ação dos EUA?
Obtenha o relatório anual, métricas financeiras padronizadas, os 50 maiores acionistas e estimativas de consenso de uma só vez, sem precisar alternar entre vários terminais de dados.
:::

::: details **Notícias financeiras e dados do setor** — Está acompanhando pontos críticos do mercado ou mudanças nas políticas?
Consulte notícias de mercado da Caixin, dados sobre títulos, fundos e contratos futuros, além de relações de cadeia de suprimentos de empresas listadas; acesse também notícias, políticas, comunicados e atualizações rápidas da plataforma nacional de informações financeiras Xinhua Finance. Todas as fontes são confiáveis ​​e rastreáveis.
:::

::: details **Consulta de normas técnicas** — Precisa verificar a conformidade com normas chinesas?
Pesquise normas nacionais (GB), setoriais, locais e de associações por número ou tópico, obtendo informações sobre o status e acesso ao texto integral.
:::

#### Abrangência

| Categoria | Escopo |
|---|---|
| Ações e mercados financeiros | Wind, S&P Capital IQ, SEC EDGAR; cotações (ações A, Hong Kong, EUA), indicadores, dados financeiros, avaliação (valuation), estimativas; mais de 8.000 documentos de empresas listadas nos EUA |
| Notícias financeiras e dados do setor | Caixin, Xinhua Finance; notícias e boletins de mercado, comunicados de empresas, políticas regulatórias, dados de títulos/fundos/contratos futuros, registros de inadimplência de crédito, vínculos na cadeia de suprimentos |
| Macroeconomia | Banco Mundial, FMI, OCDE, FRED, NBS da China, OMS, FAO; mais de 50 anos, 189 países; indicadores nacionais, provinciais e municipais da China (PIB, comércio, população, taxas de câmbio, IPC, balanço de pagamentos) |
| Normas da China | Normas nacionais (GB), setoriais, locais e de associações: identificadores, títulos, status, detalhes; texto integral oficial de algumas normas GB e normas públicas de associações |
| Dados corporativos | Registro, estrutura acionária, risco jurídico e gráfico de entidades relacionadas para empresas da China continental |
| Literatura acadêmica | Milhões de artigos em física, matemática, ciência da computação, finanças quantitativas e economia, incluindo preprints |
| Jurídico | Yuandian Legal e outras bases de dados jurídicas de referência: leis, regulamentos e decisões judiciais da China; pesquisa de legislação em diferentes níveis de autoridade; pesquisa de jurisprudência (casos comuns e precedentes de referência) |
| Triagem inteligente | Gildata e outras bases de dados renomadas: triagem em linguagem natural de ações, fundos e gestores de fundos; dados macroeconômicos e setoriais, relatórios de pesquisa, comunicados e notícias |

#### Cobrança e limitações

- As consultas de dados são cobradas por chamada e consomem créditos da conta Kimi Code
- O plugin oferece consultas somente para leitura; não há funcionalidades de escrita ou negociação disponíveis
- Indicadores técnicos e preços em tempo real estão disponíveis apenas durante o horário de negociação
- As informações geradas por IA servem apenas como referência e não constituem aconselhamento de investimento ou de negócios

### Kimi WebBridge <Badge type="tip" text="v1.11.3" />

O Kimi WebBridge permite que a IA controle seu navegador diretamente: não se trata de um emulador nem de um crawler, mas sim do navegador que você usa no dia a dia, com suas sessões de login e cookies. A IA pode abrir páginas, ler conteúdos, clicar em botões, preencher formulários e capturar telas exatamente como você faz, poupando você de tarefas repetitivas na web. Confira o [site do Kimi WebBridge](https://www.kimi.com/features/webbridge) para uma visão geral do produto.

#### Instale a extensão do navegador

Após a instalação via `/plugins`, você também precisa da extensão Kimi WebBridge no seu navegador para que a IA possa controlá-lo. Existem duas maneiras de instalá-la:

**Opção 1: Instalar a partir de uma loja (recomendado)**

Abra a página da [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) ou do [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg) e clique em Adicionar.

**Opção 2: Instalação manual**

Use esta opção caso não consiga acessar as lojas de extensões:

1. [Baixe o pacote da extensão](https://kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip) e descompacte-o
2. Digite `chrome://extensions/` na barra de endereços para abrir a página de extensões e, em seguida, ative o **Modo do desenvolvedor** no canto superior direito

   ![Ativar o Modo do desenvolvedor](../../media/webbridge-dev-mode.jpeg)

3. Clique em **Carregar sem compactação** no canto superior esquerdo e selecione a pasta `kimi-webbridge-extension` descompactada

   ![Carregar a extensão descompactada](../../media/webbridge-load-unpacked.jpeg)

4. Após a instalação, o ícone do Kimi WebBridge aparecerá na barra de ferramentas do navegador. A presença do ícone indica que a instalação foi bem-sucedida e que a IA já pode começar a atuar nas páginas da web para você.

   ![O ícone do Kimi WebBridge na barra de ferramentas do navegador](../../media/webbridge-install-success.jpeg)

   #### O que você pode fazer

- **Automação na web**: Basta dizer o que precisa, e a IA navega por páginas, preenche formulários, lê conteúdo e captura telas para você
- **Pesquisa de tendências em redes sociais**: Explore automaticamente tópicos em alta no X (Twitter), Weibo e Xiaohongshu, abra as postagens mais curtidas uma a uma para capturar telas e extrair pontos de vista principais, e organize tudo em uma biblioteca de pesquisa com sugestões de tópicos
- **Coleta de vagas de emprego**: Filtre vagas em sites de recrutamento por palavra-chave, cidade e tipo de trabalho, e organize títulos, links, empresas, salários e métodos de candidatura em uma tabela
- **Análise da concorrência**: Faça perguntas em lote a vários produtos de IA e colete as respostas para criar relatórios de comparação lado a lado
- **Comparação de preços de voos**: Consulte o mesmo itinerário em várias plataformas de viagem, registre companhias aéreas, horários de partida/chegada e links ordenados por preço, e receba opções recomendadas

### Kimi Computer Use <Badge type="tip" text="v0.5.4" />

O Kimi Computer Use permite que a IA opere seus aplicativos de desktop diretamente, realizando ações como clicar, arrastar, rolar e digitar. A versão para macOS funciona silenciosamente em segundo plano, sem assumir o controle do mouse (embora algumas ações que geram janelas pop-up ainda possam trazer um aplicativo para o primeiro plano); consulte [as notas abaixo](#notes-for-the-windows-version) para saber como a versão para Windows difere.

#### Autorização (macOS)

Ao utilizar o Kimi Computer Use pela primeira vez após a instalação, uma janela de autorização será exibida. Basta seguir as instruções:

1. Clique em **Autorizar** ao lado de **Acessibilidade** e **Gravação de Tela** e ative ambas as permissões nos Ajustes do Sistema: a primeira permite realizar cliques, digitação e rolagem; a segunda permite ler o conteúdo da tela e localizar elementos da interface
2. Ative a opção **Kimi Code** na seção "Conectar agentes locais" e, em seguida, reinicie o Kimi Code para que a alteração entre em vigor

<div style="max-width: 380px; margin: 0 auto;">

![Janela de autorização do Kimi Computer Use](../../media/kimi-computer-use-auth.jpeg)

</div>

#### Observações sobre a versão para Windows

A instalação da versão para Windows (WinCU) difere da versão para macOS: execute `/plugins install https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip` no Kimi Code e reinicie o programa após a instalação. Alguns pontos importantes antes de usar:

- **Pode assumir temporariamente o controle do mouse e teclado**: Ao contrário da versão para macOS, a versão para Windows não consegue injetar comandos em segundo plano de forma confiável; ela pode ativar brevemente a janela de destino e utilizar o mouse e o teclado reais durante a execução das ações.
- **Requisitos do sistema**: Windows 10 versão 1903 (Build 18362) ou superior, ou Windows 11 (arquitetura x64); é necessária uma sessão de área de trabalho interativa real e, no caso do Windows Server, o recurso "Experiência da Área de Trabalho" (Desktop Experience) deve estar instalado.
- **Não requer permissões adicionais**: O Windows não exige as permissões de Acessibilidade e Gravação de Tela que são necessárias no macOS.
- **Nível de privilégio correspondente**: Se o aplicativo de destino for executado como administrador, o KimiCU também deverá ser executado com o mesmo nível de privilégio.

#### O que você pode fazer

- **Organizar e inserir informações**: Deixe a IA reunir informações dispersas em notas, planilhas ou no seu aplicativo de anotações, em vez de digitar tudo manualmente.
- **Percorrer fluxos de sites e aplicativos**: Após alterar uma página, permita que a IA navegue pelos fluxos principais e capture a tela de cada etapa para confirmar se a renderização e a navegação estão funcionando corretamente.
- **Executar operações repetitivas**: Tarefas que envolvem abrir, copiar, colar e verificar repetidamente podem ser realizadas silenciosamente em segundo plano, sem interferir no uso do mouse.
- **Realizar tarefas com etapas definidas**: Para fluxos com passos claros, basta descrevê-los e a IA os seguirá; por exemplo, você pode pedir à IA para abrir o NetEase Cloud Music e reproduzir uma música específica.
- **Lidar com softwares sem API**: Muitas ferramentas profissionais e sistemas internos não possuem CLI ou API; tarefas que antes exigiam cliques manuais agora podem ser delegadas à IA, como cortar os três segundos iniciais de um clipe no Final Cut Pro e exportá-lo.

::: Nota de aviso
Não confie a ele tarefas que envolvam dinheiro, contas ou publicação — como pagamentos e transferências, exclusão de arquivos importantes, alteração de senhas ou postagem de conteúdo. Para avaliar se uma tarefa é adequada, verifique três pontos: o resultado é verificável, a ação é reversível e o risco de erro é baixo.
:::

## Manifesto do Plugin

Um plugin é um diretório ou arquivo ZIP que contém um manifesto. O manifesto pode ser colocado em qualquer um dos seguintes locais:

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

Quando ambos os arquivos existem, o `kimi.plugin.json` tem precedência.

Exemplo:

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Fluxos de trabalho de análise e dados financeiros para a Kimi Code CLI",
  "skills": "./skills/",
  "systemPromptPath": "./SYSTEM.md",
  "sessionStart": {
    "skill": "using-finance"
  },
  "interface": {
    "displayName": "Kimi Finance",
    "shortDescription": "Dados de mercado e fluxos de trabalho de análise financeira"
  }
}
```

Campos suportados:

| Campo | Descrição |
| --- | --- |
| `name` | Obrigatório; serve como o ID do plugin. Deve corresponder ao padrão `[a-z0-9][a-z0-9_-]{0,63}` |
| `version`, `description`, `keywords`, `author`, `homepage`, `license` | Metadados de exibição |
| `interface` | Exibido em `/plugins`: `displayName`, `shortDescription`, `longDescription`, `developerName`, `websiteURL` |
| `skills` | Um ou mais caminhos `./` dentro da raiz do plugin; se omitido, o arquivo `SKILL.md` na raiz é considerado a única raiz da Skill |
| `agents` | Um ou mais caminhos `./` dentro da raiz do plugin, apontando para [arquivos de agente](./agents.md#custom-agents); se omitido, `agents/` é detectado automaticamente |
| `sessionStart.skill` | Carrega a Skill do plugin especificada no Agente principal quando uma sessão nova ou retomada é iniciada |
| `skillInstructions` | Instruções adicionais anexadas sempre que uma Skill deste plugin é carregada |
| `systemPrompt` | Instruções em linha incorporadas ao prompt do sistema do agente enquanto o plugin estiver habilitado |
| `systemPromptPath` | Um caminho `./` para um arquivo de texto UTF-8; o conteúdo é anexado após `systemPrompt` quando ambos estão presentes |
| `mcpServers` | Declarações de servidores MCP; habilitados por padrão, podem ser desabilitados em `/plugins` |
| `hooks` | Regras de hook executadas em eventos de ciclo de vida enquanto habilitado; consulte [Hooks em Plugins](#hooks-in-plugins) |
| `commands` | Um ou mais caminhos `./` para um diretório ou arquivo `.md`; registra os arquivos Markdown contidos neles como comandos de barra (slash commands). Consulte [Comandos de Barra de Plugin](#plugin-slash-commands) |

Campos de tempo de execução não suportados, como `tools`, `apps`, `inject` e `configFile`, aparecem como diagnósticos e são ignorados.

### Instruções de prompt do sistema

Os plugins injetam instruções no prompt do sistema do agente por meio dos campos `systemPrompt` e `systemPromptPath`. Esta seção aborda três tópicos: formato de escrita e momento da leitura, limites de tamanho e as diferenças entre as duas engines.

### Formato de escrita e momento da leitura

Use `systemPrompt` para uma instrução curta inserida diretamente no código (inline), ou `systemPromptPath` para manter instruções mais longas em um arquivo na raiz do plugin. Se ambos os campos estiverem presentes, o texto inline aparece primeiro, seguido pelo conteúdo do arquivo. O conteúdo do arquivo é lido quando o plugin é instalado ou recarregado; portanto, as alterações só entram em vigor após o comando `/plugins reload`. Por exemplo:

```json
{
  "name": "code-review",
  "systemPromptPath": "./SYSTEM.md"
}
```

O prompt do agente integrado inclui automaticamente instruções provenientes de plugins habilitados. Um arquivo `SYSTEM.md` ou de agente personalizado define seu próprio modelo; portanto, inclua `${plugin_sections}` onde as instruções fornecidas pelos plugins devem aparecer. Se o modelo personalizado incluir `${base_prompt}` e esse padrão efetivo já contiver o bloco de plugins, não adicione `${plugin_sections}` novamente. Consulte [Agentes personalizados e SYSTEM.md](./agents.md#overriding-the-main-agents-system-prompt-with-systemmd) para ver a tabela completa de variáveis.

### Limites de tamanho

Cada campo (o `systemPrompt` em linha e o arquivo `systemPromptPath`) é limitado a 32 KB (UTF-8 bytes); conteúdo que exceda esse limite é ignorado e relatado nos diagnósticos do plugin. Considerando todos os plugins habilitados, uma única construção de prompt injeta, no máximo, 64 KB de instruções; contribuições que ultrapassem esse limite são descartadas com um aviso, incluindo casos em que o texto em linha e o arquivo de um único plugin, somados, excedem o limite.

### Diferenças entre as duas engines

As contribuições para o prompt do sistema entram em vigor em todas as interfaces do Kimi Code: a TUI interativa, o `kimi -p` e o `kimi web` operam utilizando a v2 engine.

<details>
<summary>Comportamento de atualização de instruções nas duas engines</summary>

Novas sessões e agentes recém-criados leem as contribuições dos plugins habilitados no momento. Uma solicitação em andamento mantém o prompt do sistema que já estava sendo utilizado. O comando `/plugins reload` atualiza a lista de habilidades dos plugins e solicita a reconstrução do prompt para agentes ativos; utilize-o quando precisar que a alteração seja efetivada deliberadamente antes da próxima interação.

Na engine v2, instalar, habilitar, desabilitar ou remover um plugin atualiza o catálogo imediatamente, e uma reconstrução posterior do prompt (por exemplo, após compactação ou alteração na política de ferramentas) pode incorporar as novas seções. O mecanismo legado mantém o snapshot de plugins de cada sessão ativa até que o comando `/plugins reload` seja executado ou uma nova sessão seja iniciada. Uma sessão retomada começa a partir do prompt persistido, e reconstruções posteriores seguem o comportamento específico do mecanismo descrito acima. Alternar o estado do servidor MCP de um plugin não altera as seções do prompt do sistema.

</details>

## Comandos de Barra (Slash Commands)

Os comandos de barra permitem salvar um prompt que você utiliza com frequência como um `/comando`, possibilitando acioná-lo apenas digitando o comando, em vez de redigitar todo o conteúdo.

Aqui está um exemplo mínimo de ponta a ponta. A estrutura de diretórios do plugin:

```text
kimi-finance/
  kimi.plugin.json
  commands/
    report.md
```

No manifesto (`kimi.plugin.json`), o campo `commands` aponta para onde os arquivos de comando estão localizados:

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "commands": "./commands/"
}
```

o arquivo de comando `commands/report.md`. O bloco entre as duas linhas `---` no topo é o frontmatter (metadados que descrevem o comando); todo o conteúdo abaixo é o prompt enviado ao Agente:

```markdown
---
description: Buscar e resumir os dados financeiros mais recentes de uma ação
---

Busque os dados financeiros mais recentes de $ARGUMENTS e faça um resumo da receita, do lucro e dos principais riscos.
```

Após instalar e habilitar o plugin, digite o seguinte no chat:

```text
/kimi-finance:report TSLA
```

O Kimi substitui `$ARGUMENTS` no corpo do texto por `TSLA` e, em seguida, executa o prompt. Os três detalhes abaixo descrevem cada etapa.

### Declarando Comandos (o campo `commands`)

O campo `commands` aceita um único caminho `./` ou um array de caminhos, sendo que cada um aponta para um diretório ou arquivo `.md` na raiz do plugin:

- Apontando para um **diretório**: coleta recursivamente todos os arquivos `.md` contidos nele; cada um se torna um comando.
- Apontando para um **único arquivo `.md`**: registra apenas esse arquivo.
- Apontando para um arquivo que não seja `.md` ou para um caminho inexistente: gera um diagnóstico (exibido no painel `/plugins`) e é ignorado.

### Escrevendo um Arquivo de Comando

Um arquivo de comando possui duas partes: um **frontmatter** opcional (os metadados entre as duas linhas `---` no topo, onde você define `name` e `description`) e o **corpo** (o prompt após o `---`). Quando um campo é omitido, o comportamento padrão é o seguinte:

- `name` (o nome do comando): derivado do caminho do arquivo em relação ao caminho declarado em `commands` (sem a extensão `.md` e usando `/` como separador); ex.: `commands/frontend/component.md` → `frontend/component`. Um `name` definido no frontmatter tem prioridade.
- `description` (exibida na lista de comandos): a primeira linha não vazia do corpo (truncada após 240 caracteres); se o corpo também estiver vazio, é exibida a mensagem `No description provided.` (Nenhuma descrição fornecida).

### Executando Comandos e Passando Argumentos

Os comandos recebem o prefixo do ID do plugin (seu namespace) e são registrados no formato `<plugin>:<comando>`; portanto, o comando mencionado acima é, na verdade, `/kimi-finance:report`. Isso evita conflitos entre comandos de nomes iguais provenientes de plugins diferentes.

Qualquer conteúdo digitado após o comando substitui `$ARGUMENTS` no corpo da definição (no exemplo acima, `TSLA` substitui `$ARGUMENTS`). Se o corpo não contiver `$ARGUMENTS`, mas você ainda assim fornecer argumentos, eles não serão descartados; em vez disso, serão anexados ao final do corpo no formato `ARGUMENTS: <conteúdo digitado>`.

## Skills e Início da Sessão

As Skills de plugins utilizam o mesmo formato `SKILL.md` das Skills de Agente comuns (veja [Agent Skills](./skills.md)). Abaixo, uma estrutura de diretórios típica:

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

O arquivo `sessionStart.skill` carrega uma Skill de plugin no Agente principal assim que a sessão é iniciada, sendo ideal para instruções de inicialização, regras de fluxo de trabalho ou para mapear terminologias de outras ferramentas para a Kimi Code CLI. Ele apenas injeta texto; não executa código.

Independentemente de como uma Skill é carregada (`sessionStart.skill`, `/skill:<nome>` ou invocação automática pelo modelo), as `skillInstructions` são apresentadas juntamente com a Skill daquele plugin.

## Agentes de Plugin

Um plugin pode fornecer agentes personalizados: basta declarar um ou mais diretórios `./` no campo `agents` do arquivo de manifesto (ou simplesmente colocar um diretório `agents/` na raiz do plugin). Os arquivos de agente contidos nele utilizam o mesmo formato dos [agentes personalizados](./agents.md#custom-agents) e, enquanto o plugin estiver habilitado, são detectados automaticamente e podem ser utilizados como subagentes pelo Agente principal.

```text
my-plugin/
  kimi.plugin.json
  agents/
    reviewer.md
```

Os agentes de plugin têm prioridade inferior a qualquer outra fonte de arquivos: em caso de conflito de nomes, agentes definidos pelo usuário, agentes extras, agentes de projeto e aqueles especificados via `--agent-file` prevalecem sobre o agente fornecido pelo plugin; além disso, substituir um agente nativo ainda exige a definição explícita de `override: true` no frontmatter. Após instalar, habilitar, desabilitar ou remover um plugin, a lista de agentes é atualizada em uma nova sessão (ou ao executar `/reload`); na engine v2, a sessão ativa também é atualizada após o comando `/plugins reload`.

## Servidores MCP em Plugins

Quando um plugin precisa de recursos reais de ferramentas, ele pode declarar `mcpServers` em seu manifesto, reutilizando o esquema do [MCP](./mcp.md).

Servidor stdio (comando local):

```json
{
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
  }
}
```

Servidor HTTP (serviço remoto):

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

Para servidores stdio, `command` pode ser um comando presente no `PATH` ou um caminho iniciado por `./` dentro do diretório raiz do plugin. Da mesma forma, `cwd` deve começar com `./` e estar dentro do diretório raiz do plugin; caso contrário, o servidor será ignorado.

Os servidores MCP do plugin são iniciados após o comando `/reload` ou em novas sessões. Para habilitar ou desabilitar um servidor:

```sh
/plugins mcp disable kimi-finance finance
/reload

/plugins mcp enable kimi-finance finance
/reload
```

## Hooks em Plugins

Um plugin pode declarar regras de hook em seu manifesto que são executadas durante eventos do ciclo de vida enquanto o plugin está habilitado. Cada entrada utiliza os mesmos campos de uma regra `[[hooks]]` no arquivo `config.toml` (`event`, `matcher`, `command`, `timeout`):

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "node ./hooks/check-bash.mjs",
      "timeout": 5
    }
  ]
}
```

Os hooks de plugins reutilizam o mesmo mecanismo dos hooks globais. Consulte a seção [Hooks](./hooks.md) para ver a lista de eventos, o payload JSON via stdin e como os códigos de saída e valores de retorno afetam o fluxo principal. As diferenças são:

- Os hooks de um plugin ficam ativos apenas enquanto o plugin está **habilitado**; desabilitar o plugin interrompe a execução de seus hooks.
- Cada hook é executado com o diretório de trabalho definido como a raiz do plugin; assim, o comando (`command`) pode utilizar caminhos relativos (`./`) internos ao plugin.
- O processo do hook recebe duas variáveis ​​de ambiente adicionais: `KIMI_CODE_HOME` e `KIMI_PLUGIN_ROOT` (o diretório raiz do plugin).

A instalação de um plugin não aciona seus hooks automaticamente. Eles são executados apenas quando o evento correspondente ocorre enquanto o plugin está habilitado.

## Modelo de segurança

Os plugins possuem um escopo de carregamento limitado. As seguintes operações não ocorrem durante a instalação ou a inicialização da sessão:

- Ferramentas de plugin do tipo comando e tempos de execução de ferramentas legadas não são executados
- Todos os caminhos devem permanecer dentro do diretório raiz do plugin após a resolução de links simbólicos
- Servidores MCP de plugins habilitados são iniciados após o comando `/reload` ou em novas sessões, podendo ser desabilitados a qualquer momento via `/plugins`
- Manifestos corrompidos ou caminhos inseguros aparecem nos diagnósticos do comando `/plugins info <id>` e não afetam outras sessões

## Próximos passos

- [Habilidades do agente](./skills.md) — Aprenda o formato `SKILL.md` e crie habilidades que acompanham seus plugins
- [Agentes personalizados](./agents.md) — Formato de arquivo do agente e precedência de escopo de diretório
- [MCP](./mcp.md) — O esquema reutilizado pelas declarações de servidor MCP nos plugins
- [Hooks](./hooks.md) — O mecanismo de hooks globais reutilizado pelos hooks de plugins