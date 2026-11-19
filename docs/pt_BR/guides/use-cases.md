# Casos de uso comuns

Esta página reúne cenários típicos do Kimi Code CLI, acompanhados de exemplos de prompts prontos para uso — você pode copiá-los como estão ou adaptá-los às suas necessidades.

## Entendendo um projeto desconhecido

Ao assumir um repositório com o qual você não está familiarizado, um bom primeiro passo é usar `kimi --plan` ou pressionar `Shift-Tab` para entrar no modo de planejamento (Plan mode). Assim, o agente apresentará um plano de investigação antes de realizar qualquer alteração:

```
Forneça uma visão geral da arquitetura deste repositório. Especificamente:
1. Onde fica o ponto de entrada e o que acontece durante a inicialização?
2. Como os módulos principais dependem uns dos outros?
3. Como a configuração e os dados são carregados?
Por fim, crie um diagrama simples de dependência entre os módulos.
```

Você também pode focar em uma questão específica:

```
Como funciona o loop de eventos (event loop) em `src/runtime`? De onde os eventos se originam e quem os consome?
```

```
Como a "aprovação de permissões" é implementada neste projeto? Quais arquivos estão envolvidos e quais são os tipos principais?
```

Para investigações de maior escala, é possível configurar o agente principal para acionar **subagentes** encarregados de realizar subtarefas em paralelo. Consulte [Agentes e subagentes](../customization/agents.md).

## Implementando uma nova funcionalidade

Descreva claramente o requisito e os critérios de aceitação. Para alterações complexas, utilize o modo de planejamento (Plan mode) para confirmar a abordagem antes da execução:

```
Adicione um utilitário de repetição (retry) em src/utils:
- Assinatura: retry<T>(fn: () => Promise<T>, options): Promise<T>
- Opções: maxAttempts, initialDelayMs, backoffFactor
- Em caso de falha, lance o erro ocorrido na última tentativa
- Adicione uma suíte de testes unitários que cubra: sucesso na primeira tentativa, sucesso após repetições e falha em todas as tentativas
```

Se o resultado não estiver como esperado, basta descrever o que precisa ser alterado — não é necessário editar manualmente:

```
O cálculo de backoff utiliza um valor fixo. Gostaria de adicionar um pouco de aleatoriedade (jitter) para evitar o efeito "thundering herd" (sobrecarga repentina). Atualize a implementação e os testes.
```

## Correção de um bug

Forneça o sintoma, os passos para reprodução e o comportamento esperado de uma só vez, a fim de evitar trocas de mensagens desnecessárias para esclarecimentos:

```
Ao executar `npm test`, este erro ocorre ocasionalmente:

  TypeError: Cannot read properties of undefined (reading 'id')
      at SessionStore.update (src/session/store.ts:142:18)

O problema aparece apenas em casos de teste que acionam múltiplas atualizações simultaneamente. Por favor, identifique a causa e corrija-a; em seguida, execute toda a suíte de testes para confirmar a correção.
```

Quando a causa raiz não estiver clara, peça ao agente que investigue antes de realizar qualquer alteração:

```
Relato de usuário: após um login bem-sucedido, a primeira atualização da página redireciona o usuário de volta à tela de login; uma segunda atualização funciona normalmente. Por favor, identifique as causas mais prováveis ​​e aponte os pontos mais suspeitos. Confirmarei a abordagem antes que você inicie as alterações.
```

Para tarefas puramente mecânicas, você pode deixar o agente trabalhar livremente:

```
Execute a suíte de testes, corrija todos os casos de teste que apresentarem falha e, depois, execute-a novamente para garantir que tudo esteja passando (verde).
```

## Criação de testes e refatoração

Tarefas com limites claros e critérios de aceitação explícitos são particularmente adequadas para o agente:

```
O arquivo src/parser/markdown.ts atualmente quase não possui testes. Adicione uma suíte de testes unitários que cubra: parágrafos normais, listas aninhadas, blocos de código, tabelas, citações (blockquotes) e conteúdo misto. Siga o estilo de teste já utilizado no projeto.
```

```
Extraia o padrão repetitivo "ler corpo → validar → registrar (log) → responder", presente em src/handlers, para um middleware. Em seguida, execute os testes para garantir que o comportamento existente permaneça inalterado.
```

Para refatorações que envolvem múltiplos arquivos, utilize primeiro o modo "Plan" (Planejamento) para confirmar a abordagem. Você também pode usar o comando `/fork` para criar uma ramificação (branch) experimental a partir da sessão atual e acessá-la por meio de `/sessions`. A criação de um "fork" não altera a sessão original; portanto, caso o resultado não seja satisfatório, basta retornar à sessão anterior.

## Scripts pontuais e automação

Edições em lote de arquivos, coleta de estatísticas e comparações para fins de pesquisa podem ser realizadas com um único comando:

```
Altere todas as declarações `var` em arquivos `.js` dentro do diretório `src` para `const` ou `let`, dando preferência a `const` sempre que possível. Após concluir, execute o `lint` para confirmar as alterações.
```

```
Analise os logs de acesso em `logs/` referentes aos últimos 7 dias. Para cada caminho (path) de API, calcule a contagem de chamadas, bem como os tempos de resposta p50 e p99, e apresente os resultados em uma tabela Markdown.
```

```
Pesquise as principais opções de injeção de dependência para TypeScript (tsyringe, inversify, awilix). Compare-as com base em três critérios: estilo de API, requisitos de decoradores (decorators) e sobrecarga (overhead) em tempo de execução. Forneça uma recomendação que caiba em uma única página.
```

Para tarefas em lote que você sabe serem seguras, utilize `--yolo` ou `/yolo` para ignorar as solicitações de aprovação, ou configure regras de permissão (allowlist) para ferramentas específicas em [Arquivos de configuração](../configuration/config-files.md#permission).

## Tarefas agendadas e lembretes

Durante uma sessão interativa, você pode solicitar ao agente que crie lembretes pontuais ou tarefas recorrentes. O agente gera uma expressão cron com base no seu fuso horário local e reinseri o comando na mesma sessão no momento em que a tarefa é acionada:

```
Lembre-me às 14h30 de verificar a implantação (deployment).
```

```
Todos os dias úteis, às 9h, faça um resumo das falhas recentes de CI para mim.
```

```
Verifique o endpoint de integridade (health endpoint) do ambiente de produção a cada hora e me avise caso algo pareça estar errado.
```

```
Volte daqui a cerca de 10 minutos e verifique se o build foi concluído.
```

As tarefas agendadas estão vinculadas à sua sessão — você pode fechar o terminal sem problemas; elas serão recarregadas e continuarão sendo executadas quando você retomar a mesma sessão usando `kimi --session`. Elas não são transferidas para novas sessões. Tarefas recorrentes expiram após 7 dias — no último acionamento, o agente recebe um sinal de "expirado" (stale) e decide, com base em suas instruções originais, se deve encerrar ou renovar a tarefa.

Para visualizar as tarefas pendentes, basta perguntar ao agente (ele utilizará a ferramenta `CronList`, que é apenas de leitura). Para cancelar uma tarefa, peça ao agente que a remova ou mencione o ID de 8 caracteres correspondente a ela. Para consultar a documentação completa das ferramentas, acesse [Tarefas agendadas](../reference/tools.md#scheduled-tasks). Para desativar o recurso globalmente, utilize `KIMI_DISABLE_CRON=1`.

## Geração e manutenção de documentação

```
Acabei de alterar a assinatura da interface em src/auth/login.ts. Por favor, atualize o JSDoc correspondente, o código de exemplo no README e quaisquer parágrafos em docs/en/guides que mencionem essa interface.
```

```
Para cada função pública em src/api que não possua uma docstring, adicione um comentário de documentação seguindo o estilo dos já existentes.
```

```
Com base nas implementações de comandos em src/cli, gere um rascunho de referência de comandos listando cada subcomando, seus argumentos e valores padrão. Coloque-o em docs/en/reference para que eu possa revisar posteriormente.
```

Quando precisar de um registro ou de uma retrospectiva, use `kimi export <sessionId>` para empacotar a sessão em um arquivo ZIP, ou utilize `/export-md` dentro da TUI para exportar uma transcrição em formato Markdown.

## Próximos passos

- [Agentes e subagentes](../customization/agents.md) — como fazer com que o agente distribua subtarefas para execução em paralelo
- [Hooks](../customization/hooks.md) — acione scripts locais na conclusão de tarefas ou em outros pontos do ciclo de vida
- [Ferramentas integradas](../reference/tools.md) — referência completa de todas as ferramentas que o agente pode chamar