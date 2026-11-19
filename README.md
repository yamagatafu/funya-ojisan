# funya-ojisan (Anonymous Transporter Bot)

`discord-hono` を使用した、Cloudflare Workers 向けのシンプルな匿名メッセージ転送 Discord Bot です。

## 機能

- `/panel`: 匿名メッセージ送信用のボタン付きメッセージをチャンネルに投稿します。
- ボタン押下 (`open_anonymous_modal`): 入力用のモーダルを表示します。
- モーダル送信 (`anonymous_modal`): 入力内容を Discord REST API (`POST /channels/{channel.id}/messages`) 経由で指定チャンネルに転送します（Webhook 不使用）。

## セットアップ

### 1. 依存関係のインストール

```bash
pnpm install
```

### 2. 環境変数の設定

`.dev.vars.example` を参考に `.dev.vars` を作成します（ローカル開発・コマンド登録用）。

```bash
cp .dev.vars.example .dev.vars
```

| 変数名                   | 説明                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID` | Discord アプリケーション ID                                   |
| `DISCORD_PUBLIC_KEY`     | Discord アプリケーションの Public Key                         |
| `DISCORD_TOKEN`          | Discord Bot トークン                                          |
| `TARGET_CHANNEL_ID`      | 転送先チャンネル ID                                           |
| `DISCORD_GUILD_ID`       | （任意）ギルド限定で即時にコマンド登録したい場合のサーバー ID |

### 3. スラッシュコマンドの登録

```bash
pnpm register
```

### 4. ローカル開発・動作確認

```bash
pnpm dev
```

### 5. デプロイ (Cloudflare Workers)

本番環境用のシークレット・変数を設定してデプロイします。

```bash
pnpm exec wrangler secret put DISCORD_APPLICATION_ID
pnpm exec wrangler secret put DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put DISCORD_TOKEN
pnpm exec wrangler secret put TARGET_CHANNEL_ID
pnpm deploy
```

デプロイ後、Discord Developer Portal の **Interactions Endpoint URL** に Workers の URL を設定してください。

## 開発コマンド

- `pnpm lint`: Biome による Lint & Format チェック
- `pnpm format`: Biome によるフォーマット適用
- `pnpm typecheck`: `tsgo` による型チェック
- `pnpm test`: Vitest によるテスト実行
- `pnpm cf-typegen`: `wrangler types` による型定義生成
