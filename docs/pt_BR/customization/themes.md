# Temas Personalizados

A Kimi Code CLI pode utilizar um esquema de cores nativo ou um arquivo de tema JSON personalizado. Arquivos personalizados ficam no diretório themes e aparecem em `/theme` juntamente com as opções nativas.

## Tokens de cor nativos

Temas personalizados podem substituir os tokens listados abaixo. As colunas `dark` e `light` exibem os valores nativos; a opção `auto` é resolvida para uma dessas paletas na inicialização, recorrendo ao modo `dark` quando a detecção do plano de fundo do terminal não estiver disponível.

| Token | `dark` | `light` | O que controla |
| --- | --- | --- | --- |
| `primary` | `#4FA8FF` | `#1565C0` | A cor mais utilizada. Links, código inline, itens selecionados em caixas de diálogo, bordas de foco, badges, spinners |
| `accent` | `#5BC0BE` | `#00838F` | Destaque secundário. Prefixo de aprovação `▶`, caixa de código do dispositivo, espaço reservado para imagens placeholder, painéis, importação de registro |
| `text` | `#E0E0E0` | `#1A1A1A` | Texto do corpo. Corpo de caixas de diálogo, títulos de tarefas, rótulo do modelo no rodapé, títulos Markdown, marcadores de lista |
| `textStrong` | `#F5F5F5` | `#1A1A1A` | Texto com ênfase / em negrito. Caixas de diálogo de entrada, mensagens de status |
| `textDim` | `#888888` | `#454545` | Texto secundário, mais suave/atenuado. Processamento, dicas, tarefas concluídas, citações Markdown, barra de status do rodapé |
| `textMuted` | `#6B6B6B` | `#5F5F5F` | Texto mais suave/discreto. Contadores, informações de rolagem, URLs de links Markdown, bordas de blocos de código |
| `border` | `#5A5A5A` | `#737373` | Bordas de painéis e do editor, linha horizontal Markdown |
| `borderFocus` | `#E8A838` | `#92660A` | Borda de foco / atenção; atualmente apenas no painel de aprovação |
| `success` | `#4EC87E` | `#0E7A38` | Estado de sucesso. `✓`, "habilitado", concluído |
| `warning` | `#E8A838` | `#92660A` | Estado de aviso. Indicadores de "Perguntar quando necessário"/"Nunca perguntar", marcadores de itens obsoletos, dica do modo Plan |
| `error` | `#E85454` | `#B91C1C` | Estado de erro. Mensagens de erro, saída de ferramenta com falha |
| `diffAdded` | `#4EC87E` | `#0E7A38` | Linhas adicionadas no diff |
| `diffRemoved` | `#E85454` | `#B91C1C` | Linhas removidas no diff |
| `diffAddedStrong` | `#7AD99B` | `#0E7A38` | Palavras alteradas na mesma linha (diff): adicionadas e em negrito |
| `diffRemovedStrong` | `#F08585` | `#B91C1C` | Palavras alteradas na mesma linha (diff): removidas e em negrito |
| `diffGutter` | `#6B6B6B` | `#737373` | Margem de números de linha do diff |
| `diffMeta` | `#888888` | `#5F5F5F` | Metadados do diff / cabeçalhos de blocos de alteração (hunks) |
| `roleUser` | `#FFCB6B` | `#9A4A00` | Marcador e texto da mensagem do usuário, nome de ativação de habilidade |
| `shellMode` | `#BD93F9` | `#7C3AED` | Prompt do modo shell (`!`), borda do editor e a linha `$ command` ecoada |

## Use a skill `custom-theme`

Você não precisa escrever o JSON manualmente. Execute o comando integrado da skill `/custom-theme [texto adicional]` para iniciar o fluxo de trabalho de criação de temas personalizados; a skill pode selecionar cores, criar o arquivo no diretório `~/.kimi-code/themes/`, validar os valores hexadecimais e instruí-lo sobre como aplicar o tema.

Exemplos de uso:

- `/custom-theme Crie um tema escuro de tons quentes com detalhes em âmbar.`
- `/custom-theme Crie um tema claro baseado no Solarized, mas mantenha os erros bem visíveis.`
- `/custom-theme Ajuste meu tema "ember" para que as diferenças (diffs) tenham maior contraste.`

Após a ativação, a skill geralmente pergunta se você deseja uma base clara ou escura, qual estilo ou paleta prefere e se há cores específicas que deseja incluir. Se você a utilizar para editar um tema existente, certifique-se de que ela leia e faça backup do arquivo antes de sobrescrevê-lo.

## Criar um tema

Adicione um arquivo `.json` ao diretório de temas:

- `~/.kimi-code/themes/`
- ou `$KIMI_CODE_HOME/themes/` quando a variável de ambiente `KIMI_CODE_HOME` estiver definida

Crie o diretório caso ele não exista. **O nome do arquivo é o nome do tema**: `ember.json` aparece em `/theme` como `Custom: ember`.

Um tema minimalista define apenas as cores que você deseja alterar; as demais utilizam a **paleta base** (`dark` por padrão):

```json
{
  "name": "ember",
  "colors": {
    "primary": "#83A598",
    "accent": "#FE8019"
  }
}
```

Campos:

- `name` (obrigatório): o identificador do tema.
- `displayName` (opcional): um nome legível para humanos.
- `base` (opcional): a paleta integrada da qual os tokens não especificados herdam valores: `"dark"` (padrão) ou `"light"`. Defina `"base": "light"` ao criar um tema **claro** para que os tokens que você não definir permaneçam legíveis em um fundo claro (caso contrário, eles utilizarão a paleta escura como padrão).
- `colors` (opcional): os tokens de cor a serem substituídos; cada um deve ser um valor hexadecimal de 6 dígitos (por exemplo, `#FE8019`).

Use os nomes de tokens listados em [Tokens de cor integrados](#built-in-color-tokens). Qualquer token omitido utilizará a paleta base selecionada; portanto, temas parciais são permitidos:

```json
{
  "name": "just-blue",
  "colors": {
    "primary": "#3B82F6",
    "roleUser": "#3B82F6"
  }
}
```

## Selecione um tema

Duas formas:

1. **O comando `/theme`** (recomendado): abre o seletor de temas, onde temas personalizados aparecem como `Custom: <nome-do-arquivo>`. O seletor **reexamina o diretório de temas sempre que é aberto**, portanto, um arquivo de tema recém-adicionado aparece **sem necessidade de reiniciar**.
2. **[`tui.toml`](../configuration/config-files.md#tuitoml)**: defina `theme` com o nome do seu tema:

   ```toml
   # ~/.kimi-code/tui.toml
   theme = "ember"
   ```

## O que acontece em caso de erro

Os temas personalizados são projetados para nunca atrapalhar o seu fluxo de trabalho:

- **Um valor de cor inválido** (que não seja `#` seguido por 6 dígitos hexadecimais): esse item específico é ignorado silenciosamente e o sistema recorre à paleta base selecionada; as demais cores continuam sendo aplicadas.
- **Um token não reconhecido**: ignorado, sem afetar as outras cores.
- **Arquivo de tema personalizado ausente ou JSON malformado**: o sistema recorre silenciosamente à paleta `dark` nativa. Não é feita uma nova tentativa com a opção `auto`.

## Editando o tema ativo

Se você editar o arquivo de tema que está **atualmente ativo**, a alteração não é recarregada automaticamente. Para aplicar as novas cores:

- execute `/reload-tui`, o que recarrega o `tui.toml` e reaplica o tema atual (incluindo a releitura do arquivo de tema); ou
- mude para outro tema em `/theme` e depois volte para o anterior.

::: Nota de aviso
Selecionar novamente o **mesmo** tema em `/theme` não o recarrega (você receberá uma mensagem informando que o tema não foi alterado). Para recarregar as alterações no tema ativo, utilize um dos dois métodos acima.
:::

## Próximos passos

- [Arquivos de configuração](../configuration/config-files.md#tuitoml) — Referência completa dos campos do `tui.toml`, incluindo a opção `theme`