# funya-ojisan (Anonymous Transporter Bot)

`discord-hono` を使用した、Cloudflare Workers 向けのシンプルな匿名メッセージ転送 Discord Bot です。

## 機能

- `/panel`: 匿名メッセージ送信用のボタン付きメッセージを `TARGET_CHANNEL_ID` に投稿し、メッセージ ID を KV (`PANEL_KV`) に保存します。すでに前回のボタンメッセージがある場合は削除します（`MANAGE_MESSAGES` 権限が必要）。
- ボタン押下 (`open_anonymous_modal`): 入力用のモーダルを表示します。
- モーダル送信 (`anonymous_modal`): 入力内容を Discord REST API (`POST /channels/{channel.id}/messages`) 経由で `TARGET_CHANNEL_ID` に転送します（Webhook 不使用）。転送完了後、前回のボタンメッセージを削除し、新しいボタンメッセージを投稿して KV を更新します。
- `TARGET_CHANNEL_ID` 以外のチャンネルからのコマンド・ボタン・モーダル操作は無視（Ephemeral 応答）します。

> [!NOTE]
> Cloudflare Workers KV は結果整合性および同一キーへの書込み制限（1 秒あたり 1 回）があるため、短時間の連続投稿や同時送信が重なった場合に一時的にパネルが重複することがあります。その場合は管理者が `/panel` を再実行してリセットしてください。

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

| 変数名                   | 説明                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID` | Discord アプリケーション ID                                       |
| `DISCORD_PUBLIC_KEY`     | Discord アプリケーションの Public Key                             |
| `DISCORD_TOKEN`          | Discord Bot トークン                                              |
| `TARGET_CHANNEL_ID`      | 転送先チャンネル ID（本番用は `wrangler.jsonc` の `vars` で管理） |
| `DISCORD_GUILD_ID`       | （任意）ギルド限定で即時にコマンド登録したい場合のサーバー ID     |

### 3. スラッシュコマンドの登録

```bash
pnpm register
```

### 4. ローカル開発・動作確認

```bash
pnpm dev
```

### 5. デプロイ (Cloudflare Workers)

本番環境用のシークレットを設定し、`wrangler.jsonc` の `vars.TARGET_CHANNEL_ID` と `kv_namespaces`（バインディング名 `PANEL_KV`）を確認したうえでデプロイします。

```bash
pnpm exec wrangler secret put DISCORD_APPLICATION_ID
pnpm exec wrangler secret put DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put DISCORD_TOKEN
pnpm deploy
```

デプロイ後、Discord Developer Portal の **Interactions Endpoint URL** に Workers の URL を設定してください。

## 開発コマンド

- `pnpm lint`: Biome による Lint & Format チェック
- `pnpm format`: Biome によるフォーマット適用
- `pnpm typecheck`: `tsgo` による型チェック
- `pnpm test`: Vitest によるテスト実行
- `pnpm cf-typegen`: `wrangler types` による型定義生成
