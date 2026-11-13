# Primeiros passos

## O que é o Kimi Code CLI

O Kimi Code CLI é um agente de IA que opera no terminal, auxiliando na execução de tarefas de desenvolvimento de software e operações cotidianas no terminal — como ler e modificar código, executar comandos de shell, pesquisar arquivos, acessar páginas da web e planejar ou ajustar, de forma autônoma, seus próximos passos com base no feedback recebido durante o trabalho.

Ele é ideal para cenários como:

- **Escrever e modificar código**: implementar novas funcionalidades, corrigir bugs e realizar refatorações.
- **Compreender um projeto**: explorar uma base de código desconhecida e responder a perguntas sobre sua arquitetura e implementação.
- **Automatizar tarefas**: processar arquivos em lote, executar builds e testes, ou encadear múltiplos scripts.

A CLI é desenvolvida em TypeScript, distribuída via npm e executada sobre o Node.js.

## Instalação

Há duas opções de instalação disponíveis: o script de instalação oficial (recomendado; não exige que o Node.js esteja pré-instalado) e a instalação global via npm.

::: tip Antes de instalar
A Kimi Code CLI é uma aplicação TUI (interface de usuário em terminal) totalmente interativa. Para obter a melhor experiência visual, execute-a em um terminal que ofereça suporte a *true-color* (cores reais) e ligaduras, como o [Kitty](https://sw.kovidgoyal.net/kitty/) ou o [Ghostty](https://ghostty.org/).
:::

### Script de instalação (recomendado)

::: code-group

```sh [macOS / Linux]
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

:::

> No Windows, instale o [Git for Windows](https://gitforwindows.org/) antes da primeira execução. A Kimi Code CLI utiliza o Git Bash (que acompanha o Git for Windows) como seu ambiente de shell; caso o Git Bash tenha sido instalado em um local personalizado, defina a variável `KIMI_SHELL_PATH` com o caminho absoluto para o arquivo `bash.exe`.

O script baixa automaticamente a versão mais recente, verifica a integridade (checksum) e adiciona o executável `kimi` ao seu `PATH`.

### Instalação via npm

Requer Node.js 22.19.0 ou superior:

```sh
node --version
```

::: code-group

```sh [npm]
npm install -g @moonshot-ai/kimi-code
```

```sh [pnpm]
pnpm add -g @moonshot-ai/kimi-code
```

:::

## Primeira execução

Acesse o diretório do seu projeto e execute `kimi` para iniciar a interface interativa:

```sh
cd seu-projeto
kimi
```

Para executar uma única instrução sem entrar na interface interativa, utilize a flag `-p`:

```sh
kimi -p "Analise a estrutura de diretórios deste projeto"
```

Para retomar a sessão anterior, adicione a flag `-c`:

```sh
kimi -c
```

Na primeira execução, é necessário configurar uma fonte de API. Na interface interativa, digite `/login` para iniciar o processo de autenticação:

```
/login
```

O comando `/login` abre um seletor de plataforma com duas opções:

- **Kimi Code (OAuth)** — fluxo de código de dispositivo (device-code flow): abra o link em qualquer dispositivo, faça login e insira o código para autorizar.
- **Chave de API da plataforma Kimi** — insira uma chave de API obtida em `platform.kimi.com` ou `platform.kimi.ai`.

Para sair (encerrar a sessão), digite `/logout` e as credenciais atuais serão removidas.

::: tip Uso de outros provedores de IA
Se você deseja conectar serviços da Anthropic, OpenAI, Google ou outros provedores, edite diretamente o arquivo `~/.kimi-code/config.toml` para configurar a chave de API. Consulte [Provedores e modelos](../configuration/providers.md) para mais detalhes. Para obter uma referência completa de todas as opções de configuração, veja [Arquivos de configuração](../configuration/config-files.md), [Variáveis ​​de ambiente](../configuration/env-vars.md) e [Sobrescritas de configuração](../configuration/overrides.md).
:::

## Sua primeira conversa

Após fazer login, descreva uma tarefa usando linguagem natural. Um bom ponto de partida é pedir ao Kimi Code CLI que se familiarize com o projeto:

```
Analise a estrutura de diretórios deste projeto e descreva brevemente a finalidade de cada diretório.
```

O Kimi Code CLI utiliza automaticamente ferramentas de leitura de arquivos, busca e outras funcionalidades para explorar o conteúdo relevante antes de responder. Operações de apenas leitura são executadas automaticamente, sem necessidade de confirmação. Para operações que modificam arquivos ou executam comandos no terminal (shell), o sistema solicitará sua confirmação antes de prosseguir.

Você também pode descrever uma tarefa mais específica diretamente:

```
Adicione uma função em src/utils que converta qualquer string para o formato kebab-case e crie um teste unitário para ela.
```

O Kimi Code CLI planeja as etapas, modifica o código, executa os testes e informa o que foi realizado em cada passo.

::: tip Não sabe o que fazer? Digite `/help`
Digite `/help` a qualquer momento para abrir o painel integrado de comandos e atalhos de teclado. Use as setas `↑`/`↓` para navegar e a tecla `Esc` para fechar. Para sair, digite `/exit`, pressione `Ctrl-C` duas vezes ou pressione `Ctrl-D` com o campo de entrada vazio.
:::

## Comandos e atalhos de teclado comuns

Para quem está começando, estas são as informações essenciais:

**Comandos de sessão**

| Comando | Descrição |
| --- | --- |
| `/new` | Inicia uma nova sessão, limpando o contexto atual |
| `/sessions` | Exibe o histórico de sessões e permite retomar uma delas |
| `/model` | Altera o modelo utilizado |
| `/compact` | Comprime manualmente o contexto para liberar tokens |
| `/fork` | Cria uma cópia independente da sessão atual, mantendo todo o histórico (você permanece na sessão original) |

**Atalhos de teclado mais utilizados**

| Atalho | Descrição |
| --- | --- |
| `Esc` | Interrompe a exibição de uma resposta (streaming) / fecha um pop-up |
| `Ctrl-C` | Interrompe a exibição de uma resposta; pressione duas vezes quando o sistema estiver ocioso para sair |
| `Shift-Tab` | Alternar modo de planejamento |
| `Ctrl-S` | Inserir uma mensagem no meio do fluxo, sem aguardar a conclusão da resposta atual |
| `Ctrl-O` | Recolher/expandir a saída de ferramentas e os resumos de compactação |

Para conferir a lista completa, digite `/help` ou consulte a [Referência de comandos de barra (slash commands)](../reference/slash-commands.md) e os [Atalhos de teclado](../reference/keyboard.md).

## Onde os dados são armazenados

Por padrão, a Kimi Code CLI armazena seus dados locais em `~/.kimi-code/` — incluindo arquivos de configuração, registros de sessão, logs e o cache de atualizações. Para alterar esse local, defina um novo caminho por meio da variável de ambiente `KIMI_CODE_HOME`. Para conferir a estrutura completa dos diretórios, consulte [Locais de dados](../configuration/data-locations.md) e [Variáveis ​​de ambiente](../configuration/env-vars.md).

## Atualização e desinstalação

Após a instalação, verifique se o executável está pronto para uso:

```sh
kimi --version
```

**Atualização**: execute `kimi upgrade` — a CLI verificará se há uma versão mais recente e apresentará as opções de atualização. Selecione `Install update now` (Instalar atualização agora) para atualizar com base na origem da sua instalação atual. Você também pode realizar a atualização diretamente pelo gerenciador de pacotes:

```sh
npm install -g @moonshot-ai/kimi-code@latest
```

**Desinstalação**: se você realizou a instalação por meio do script, exclua o executável `kimi`. Se a instalação foi feita via npm:

```sh
npm uninstall -g @moonshot-ai/kimi-code
```

## Próximos passos

- [Interação e entrada de dados](./interaction.md) — explicações sobre operações na caixa de entrada, fluxo de aprovação, modo "Plan" (Planejamento) e modo "Ask When Needed" (Perguntar quando necessário)
- [Sessões e contexto](./sessions.md) — como retomar sessões, comprimir o contexto e exportar sessões
- [Casos de uso comuns](./use-cases.md) — exemplos de prompts para tarefas frequentes
