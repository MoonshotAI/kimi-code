# Kimi Code CLI

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/) <br>
[Documentation](https://moonshotai.github.io/kimi-code/en/) · [Issues](https://github.com/MoonshotAI/kimi-code/issues) · [English](README.md) · [中文](README.zh-CN.md)

![Kimi Code の使用デモ](./docs/media/intro.gif)

## Kimi Code CLI とは

Kimi Code CLI はターミナル上で動作する AI コーディングエージェントです。コードの読み書き、シェルコマンドの実行、ファイルの検索、Web ページの取得を行い、得られたフィードバックに基づいて次の手順を選択できます。Moonshot AI の Kimi モデルですぐに利用できるほか、互換性のある他のプロバイダーを使用するよう設定することもできます。

## インストール

公式スクリプトでインストールします。Node.js は不要です。

- **macOS または Linux**：

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Windows（PowerShell）**：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

> Windows では、Kimi Code CLI が同梱の Git Bash をシェル環境として使用するため、初回起動前に [Git for Windows](https://gitforwindows.org/) をインストールしてください。Git Bash を標準以外の場所にインストールした場合は、`KIMI_SHELL_PATH` に `bash.exe` の絶対パスを設定します。

その後、新しいシェルセッションで次を実行します。

```sh
kimi --version
```

npm を使用したインストール、アップグレード、アンインストールについては、[はじめに](https://moonshotai.github.io/kimi-code/en/guides/getting-started)を参照してください。

## クイックスタート

プロジェクトを開き、対話型 UI を起動します。

```sh
cd your-project
kimi
```

初回起動時は Kimi Code CLI で `/login` を実行し、Kimi Code OAuth または Moonshot AI Open Platform API キーを選択します。ログイン後、最初のタスクを試してみましょう。

```
Take a look at this project and explain its main directories.
```

## 主な機能

- **単一バイナリで配布。** 1 つのコマンドでインストールでき、Node.js のセットアップ、PATH の調整、グローバルモジュールの競合はありません。
- **非常に高速な起動。** TUI は数ミリ秒で準備が整うため、新しいセッションをすぐに開始できます。
- **専用設計の TUI。** 長時間の集中したエージェントセッションに最適化された、細部まで調整済みのインターフェースです。
- **動画入力。** 画面録画やデモ動画をチャットにドロップすれば、言葉で説明しにくい内容をエージェントが確認できます。参照動画から LUT を作成したり、長い動画を短く編集したり、画面録画を動作するコードに変換したりできます。
- **AI-native な MCP 設定。** JSON を手動編集することなく、`/mcp-config` との対話で Model Context Protocol サーバーを追加、編集、認証できます。
- **豊富なプラグインエコシステム。** マーケットプレイスや任意の GitHub リポジトリからスキル、MCP サーバー、データソースをインストールでき、各インストール元の信頼レベルも事前に表示されます。
- **集中的な並列作業に対応するサブエージェント。** 組み込みの `coder`、`explore`、`plan` サブエージェントを隔離されたコンテキストで実行し、メインの会話を整理された状態に保てます。
- **ライフサイクルフック。** 重要なタイミングでローカルコマンドを実行し、危険なツール呼び出しの制御、意思決定の監査、デスクトップ通知の送信、独自の自動化との連携ができます。
- **エディターおよび IDE 連携（ACP）。** `kimi acp` を使い、Zed、JetBrains、その他の [Agent Client Protocol](https://agentclientprotocol.com/) クライアントから Kimi Code CLI セッションを直接操作できます。

## エディターで使用する（ACP）

Kimi Code CLI は [Agent Client Protocol](https://agentclientprotocol.com/) に対応しているため、ACP 対応のエディターや IDE（Zed、JetBrains など）は stdio 経由でセッションを操作できます。一度ログインした後、エディターから `kimi acp` サブコマンドを指定すれば、再ログインは不要です。

Zed では、`~/.config/zed/settings.json` に次の設定を追加します。

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

その後、Zed の Agent パネルで新しい会話を開きます。JetBrains の設定とトラブルシューティングについては [IDE で使用する](https://moonshotai.github.io/kimi-code/en/guides/ides)、完全な機能一覧については [`kimi acp` リファレンス](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)を参照してください。

## ドキュメント

- [はじめに](https://moonshotai.github.io/kimi-code/en/guides/getting-started)
- [操作と承認](https://moonshotai.github.io/kimi-code/en/guides/interaction)
- [セッション](https://moonshotai.github.io/kimi-code/en/guides/sessions)
- [IDE で使用する（ACP）](https://moonshotai.github.io/kimi-code/en/guides/ides)
- [設定](https://moonshotai.github.io/kimi-code/en/configuration/config-files)
- [コマンドリファレンス](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)

## 開発

要件：Node.js 24.15.0 以上、pnpm 10.33.0。

```sh
git clone https://github.com/MoonshotAI/kimi-code.git
cd kimi-code
pnpm install
```

```sh
pnpm dev:cli    # run the CLI in dev mode
pnpm test       # run tests
pnpm typecheck  # TypeScript check
pnpm lint       # oxlint
pnpm build      # build all packages
```

完全なコントリビューションガイドについては [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## コミュニティ

- [Issues](https://github.com/MoonshotAI/kimi-code/issues)
- セキュリティ脆弱性については [SECURITY.md](SECURITY.md) を参照してください。

## 謝辞

私たちの TUI は [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) を基盤として構築されています。`pi-tui` の作者による貴重な取り組みに感謝します。

## ライセンス

[MIT License](LICENSE) のもとで公開されています。
