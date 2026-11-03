# Migrando do kimi-cli

::: info
O Kimi Code CLI passou por uma atualização de versão principal — migrando de Python/uv para Node.js. Isso proporciona um processo de instalação mais simples, uma inicialização mais rápida e uma interface de terminal totalmente reformulada. A versão anterior será descontinuada gradualmente; por isso, recomendamos que você realize a atualização o quanto antes.
:::

Se você está migrando da versão anterior, siga os passos abaixo — um único comando é suficiente para transferir suas configurações, servidores MCP e histórico de sessões para a nova versão.

## O que há de novo

- **Sem dependência de Python/uv**: Reconstruído em Node.js — não exige ambiente Python, tornando a instalação mais simples.
- **Binário nativo, pronto para uso**: Inicialização mais rápida e menor consumo de recursos.
- **Interface de terminal reformulada**: Uma experiência mais fluida e responsiva.
- **Migração completa de dados**: Configurações, servidores MCP e histórico de sessões são transferidos perfeitamente.

## Como migrar

Existem duas formas de realizar a migração.

Na **primeira vez que você executar o `kimi`** após instalar o `kimi-code`, ele verificará automaticamente se existem dados do `kimi-cli` no diretório `~/.kimi/`. Caso encontre, uma solicitação de migração será exibida; você poderá optar por realizar a migração imediatamente, deixá-la para depois ou solicitar que essa pergunta não seja exibida novamente.

Você também pode **executar o processo manualmente a qualquer momento**:

```sh
kimi migrate
```

É possível escolher se você deseja migrar também as sessões de chat. Se você ainda não precisar do histórico, selecione **Apenas configurações** (Config only); caso contrário, escolha **Configurações + N sessões** (Config + N sessions) para transferir tudo de uma só vez. Um resumo será exibido ao final.

## O que acontece durante a migração

**O que é migrado**: a configuração (`config.toml`), a configuração dos servidores MCP, o histórico de entradas e as sessões de chat que você optou por migrar.

**O que não é migrado**: credenciais de login via OAuth e autorizações de serviços MCP não são copiadas; portanto, após a migração, será necessário executar o comando `/login` novamente e autorizar os servidores MCP mais uma vez. Plugins do `kimi-cli` também não estão incluídos no processo.

::: dica
A migração **nunca modifica nem exclui** os dados antigos armazenados em `~/.kimi/`. O `kimi-cli` continua funcionando normalmente, e ambos não interferem um no outro. O processo de migração pode ser executado várias vezes — sessões que já foram migradas não são importadas novamente.
:::

Após a migração, as sessões importadas do `kimi-cli` aparecem com a etiqueta `[imported]` no seletor de sessões, permitindo que você as distinga das novas.