# Usando a Kimi Code CLI em IDEs

A Kimi Code CLI oferece suporte à integração com IDEs por meio do [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), permitindo que você utilize a codificação assistida por IA diretamente dentro do seu editor.

## Pré-requisitos

Antes de configurar sua IDE, certifique-se de que a Kimi Code CLI esteja instalada e que o processo de login tenha sido concluído.

O servidor ACP é disponibilizado por meio do subcomando `kimi acp`. A IDE o executa como um processo filho e estabelece comunicação via stdin/stdout utilizando JSON-RPC. Sempre que a IDE cria uma sessão, a CLI reutiliza o estado de autenticação existente — não sendo necessário realizar o login novamente.

::: tip Observação sobre o PATH
Processos filhos iniciados a partir da interface gráfica (GUI) de uma IDE no macOS, geralmente, **não** herdam o `PATH` do shell do terminal. Se o `kimi` não estiver em um diretório do sistema, como `/usr/local/bin`, utilize o caminho absoluto na configuração da sua IDE. Execute `which kimi` no terminal para identificar o caminho em uso.
:::

## Usando a Kimi Code CLI no Zed

O [Zed](https://zed.dev/) é um editor moderno com suporte nativo a ACP.

Adicione o seguinte ao arquivo de configuração do Zed, localizado em `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Campos de configuração:

- `type`: valor fixo `"custom"`
- `command`: caminho para o executável da Kimi Code CLI. Se o `kimi` não estiver no seu `PATH`, utilize o caminho completo (por exemplo, `/Users/you/.local/bin/kimi`).
- `args`: argumentos de inicialização. O subcomando `acp` coloca a CLI no modo ACP.
- `env`: variáveis ​​de ambiente adicionais; geralmente, deve ser deixado vazio. O Zed injeta um ambiente padrão automaticamente.

Após salvar, inicie uma nova conversa no painel de Agentes (Agent panel) do Zed; isso abrirá um subprocesso ACP da `Kimi Code CLI` utilizando a configuração definida acima. Servidores MCP declarados na seção `agent_servers` do Zed também são encaminhados para o Kimi por meio do protocolo ACP.

## Utilizando a Kimi Code CLI em IDEs da JetBrains

As IDEs da JetBrains (IntelliJ IDEA, PyCharm, WebStorm, etc.) oferecem suporte ao ACP por meio do plugin de chat de IA (AI chat plugin).

Caso você não possua uma assinatura do JetBrains AI, é possível habilitar a opção `llm.enable.mock.response` no "Registry" para acessar o painel de chat de IA em cenários que utilizam apenas o ACP. Pressione a tecla Shift duas vezes e pesquise por "Registry" para abri-lo.

No menu do painel de chat com IA, clique em **Configurar agentes ACP** e adicione a seguinte configuração:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "command": "~/.local/bin/kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

A JetBrains é rigorosa quanto ao campo `command` — utilize sempre um **caminho absoluto**, que pode ser obtido executando `which kimi` em um terminal. Após salvar, o `Kimi Code CLI` aparecerá no seletor de agentes do chat de IA.

## Usando o Kimi Code CLI no Paseo

O [Paseo](https://paseo.sh/) é um orquestrador auto-hospedado que executa e supervisiona CLIs de agentes a partir do seu desktop, da web ou de dispositivos móveis. Ele se conecta ao Kimi Code CLI via ACP, da mesma forma que uma IDE faria.

Selecione o **Kimi Code CLI** no catálogo de provedores ACP integrados do Paseo, ou adicione um provedor personalizado em `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "kimi": {
        "extends": "acp",
        "label": "Kimi Code CLI",
        "command": ["kimi", "acp"]
      }
    }
  }
}
```

O adaptador ACP genérico do Paseo não gerencia o fluxo de login; portanto, conclua o login via terminal primeiro (consulte [Pré-requisitos](#pré-requisitos)). Caso contrário, a criação da sessão falhará com o erro `Authentication required` (autenticação necessária).

## Solução de problemas

- **A sessão é desconectada imediatamente / A IDE exibe "agent exited" (agente encerrado)**: geralmente, isso indica um caminho de `command` incorreto ou a ausência de login. Execute `kimi acp` em um terminal para verificar: se o comando ficar aguardando entrada (stdin), a CLI está funcionando corretamente e o problema reside na configuração da IDE; se ele for encerrado imediatamente com um erro, siga as instruções da mensagem de erro (na maioria dos casos, será necessário executar `/login`).
- **A IDE exibe "auth required" (autenticação necessária)**: a CLI não possui um token de autenticação válido. Feche a IDE, execute `kimi` em um terminal para concluir o login e, em seguida, reinicie a IDE.
- **Ferramentas MCP não aparecem**: consulte a tabela de funcionalidades na [referência do `kimi acp`](../reference/kimi-acp.md) para confirmar se o tipo de transporte MCP configurado em sua IDE é suportado. O servidor ACP da CLI Kimi Code atualmente oferece suporte aos transportes `http`, `stdio` e `sse`; servidores MCP que utilizam o transporte `acp` são ignorados silenciosamente, e um aviso é registrado no log.

## Próximos passos

- [Referência do `kimi acp`](../reference/kimi-acp.md) — matriz de funcionalidades ACP e detalhes sobre a cobertura de métodos.
- [Referência de comandos do `kimi`](../reference/kimi-command.md) — lista completa de subcomandos.