# Build pessoal do Kimi Code

Este guia explica como compilar e usar o Kimi Code diretamente da source deste fork, sem depender do binário oficial da Moonshot.

## Quando usar

- Você quer rodar sua própria build a partir da branch `personal`.
- Você quer que o comando `kimi` aponte sempre para o executável gerado neste repositório.
- Você quer evitar que o atualizador oficial substitua seu binário personalizado.

## Pré-requisitos

- Node.js `>= 24.15.0`
- pnpm `10.33.0` (o repositório usa `corepack`)
- Sistema: Linux x64 ou Windows x64

## Comando principal

Na raiz do repositório, na branch `personal`:

```bash
node scripts/use-personal-build.mjs
```

O script vai:

1. Validar Node.js, pnpm e plataforma.
2. Instalar dependências (`pnpm install --frozen-lockfile`).
3. Compilar os assets web.
4. Compilar o executável nativo SEA (`build:native:sea`).
5. Rodar o smoke test nativo.
6. Substituir `~/.kimi-code/bin/kimi` por um launcher que aponta para o binário deste clone.
7. Desativar atualizações oficiais via `KIMI_CODE_NO_AUTO_UPDATE=1`.
8. Garantir que `~/.kimi-code/bin` esteja no PATH.

## Dry run

Para ver o que seria feito sem alterar nada:

```bash
node scripts/use-personal-build.mjs --dry-run
```

## Atualizar depois de puxar do upstream

```bash
git fetch upstream
git rebase upstream/main   # ou merge, se preferir
node scripts/use-personal-build.mjs
```

## Usar em outro computador

1. Clone este fork e entre na branch `personal`.
2. Instale Node.js `>= 24.15.0` e ative o corepack:
   ```bash
   corepack enable
   corepack prepare pnpm@10.33.0 --activate
   ```
3. Rode:
   ```bash
   node scripts/use-personal-build.mjs
   ```

Suas configurações (`~/.kimi-code/config.toml`), credenciais, sessões e plugins serão preservadas.

## Por que não `pnpm build`?

O comando `pnpm build` do root compila pacotes e assets, mas **não gera o executável nativo SEA**. Para produzir o binário `kimi`/`kimi.exe` é necessário rodar `build:native:sea`, que é exatamente o que o script `use-personal-build.mjs` faz, seguindo o mesmo fluxo do workflow oficial de release nativa.

## Windows

No Windows o script remove `~/.kimi-code/bin/kimi.exe` e cria `~/.kimi-code/bin/kimi.cmd` apontando para o `.exe` gerado no clone. A atualização do PATH é feita via PowerShell. Abra um novo terminal após rodar o script.
