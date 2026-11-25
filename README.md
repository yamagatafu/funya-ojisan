# funya-ojisan (Anonymous Transporter Bot)

`discord-hono` を使用した、Cloudflare Workers 向けの匿名メッセージ転送・リマインダ Discord Bot です。

## 機能

### 匿名メッセージ転送

- `/panel`: 匿名メッセージ送信用のボタン付きメッセージを `TARGET_CHANNEL_ID` に投稿し、メッセージ ID を KV (`PANEL_KV`) に保存したうえで前回のボタンメッセージを削除します（`MANAGE_MESSAGES` 権限が必要）。
- ボタン押下 (`open_anonymous_modal`): 入力用のモーダルを表示します。
- モーダル送信 (`anonymous_modal`): 入力内容を Discord REST API (`POST /channels/{channel.id}/messages`) 経由で `TARGET_CHANNEL_ID` に転送します（Webhook 不使用）。転送完了後、新しいボタンメッセージを投稿して KV に保存したうえで、前回のボタンメッセージを削除します。
- `TARGET_CHANNEL_ID` 以外のチャンネルからのコマンド・ボタン・モーダル操作は無視（Ephemeral 応答）します。

> [!NOTE]
> Cloudflare Workers KV は結果整合性および同一キーへの書込み制限（1 秒あたり 1 回）があるため、短時間の連続投稿や同時送信が重なった場合に一時的にパネルが重複することがあります。KV に未追跡のパネルが残った場合は不要なパネルを手動で削除したうえで、追跡用の新規パネルを再設置するために管理者が `/panel` を実行してください。

### リマインダ

指定した日時・繰り返し条件で、任意のチャンネルに通知します。時刻はすべて日本時間 (JST)、精度は 1 分単位です。

#### コマンド

| コマンド                                                          | 説明                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/remind add`                                                     | リマインダを登録します                                                           |
| `/remind in`                                                      | 「30 分後」のように、今からの経過時間で 1 回だけのリマインダを登録します         |
| `/remind edit`                                                    | 指定した項目だけを変更します                                                     |
| `/remind list`                                                    | 自分のリマインダを一覧表示します (`all:True` で全員分。`MANAGE_MESSAGES` が必要) |
| `/remind delete` / `pause` / `resume`                             | 削除 / 一時停止 / 再開します                                                     |
| メッセージを右クリック →「アプリ」→「このメッセージをリマインド」 | 元メッセージへのリンク付きで 1 回だけのリマインダを登録します                    |

`/remind add` の主なオプション:

| オプション                 | 説明                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `content` (必須)           | 通知する本文 (最大 1500 文字)                                                               |
| `time` (必須)              | 通知時刻 (`09:00` など)                                                                     |
| `repeat`                   | 1回のみ (既定) / 毎日 / 平日 / 毎週 / 隔週 / 毎月n日 / 毎月末日 / 毎月第n曜日               |
| `channel`                  | 通知先 (省略時はコマンドを実行したチャンネル)                                               |
| `date`                     | 1回のみ: 通知日 (`12/1` のように年を省略すると次に来る日付) / 繰り返し: 開始日 (隔週の起点) |
| `weekdays`                 | 曜日 (`月水金` など)。毎週・隔週・第n曜日で使用                                             |
| `day` / `nth`              | 毎月n日の「n」/ 第n曜日の「n」(5 = 最終週)                                                  |
| `mention`                  | メンション先のユーザーまたはロール (省略時は自分)                                           |
| `pre_notify`               | 事前通知 (n 分前)                                                                           |
| `nag_interval` / `nag_max` | 完了ボタンが押されるまで n 分おきに再通知 (最大回数。既定 3 回)                             |
| `holidays`                 | 祝日の扱い: 通知する (既定) / スキップ / 次の平日にずらす。1回のみでは指定できません        |
| `until` / `count`          | 終了日 / 回数の上限 (繰り返しのみ)                                                          |

`/remind edit` では、`pre_notify:0`・`nag_interval:0`・`count:0` でそれぞれの設定を解除、`until:なし` で終了日を解除できます。

使用例:

```text
/remind add content:ゴミ出し time:07:30 repeat:毎週 weekdays:火金
/remind add content:定例の資料準備 time:10:00 repeat:平日 holidays:次の平日にずらす pre_notify:10
/remind add content:薬を飲む time:21:00 repeat:毎日 nag_interval:10 nag_max:5
/remind add content:月次報告 time:09:00 repeat:毎月第n曜日 nth:5 weekdays:金 mention:@チーム
/remind in content:お湯が沸く minutes:3
```

#### 通知とボタン

- 通知には「✅ 完了」「⏰ 5分 / 15分 / 30分 / 指定…」のボタンが付きます
  - **完了**: 通知を完了済みにし、以降の再通知を止めます
  - **スヌーズ**: 指定した時間の後に再通知します (指定… は 1〜1440 分)
- ボタンを操作できるのは、登録者・メンション対象 (ロールの場合はそのメンバー)・`MANAGE_MESSAGES` を持つメンバーです
- 次の回が通知されると、前の回の通知からはボタンが外れます

#### 祝日の扱い

| 設定             | 動作                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 通知する         | 祝日も通常どおり通知します                                                                                              |
| スキップ         | 祝日に当たる回は通知しません (回数の上限には数えません)                                                                 |
| 次の平日にずらす | 祝日に当たる回を、次の平日 (土日・祝日でない日) の同じ時刻に通知します。振替先に通常の予定がある場合は 1 回にまとめます |

> [!NOTE]
> 祝日は「国民の祝日に関する法律」に基づいて計算しています (振替休日・国民の休日を含む、2099 年まで)。祝日法が改正された場合は `src/reminder/holidays.ts` の修正が必要です。

#### 権限と上限

- 通知先チャンネルを閲覧でき、メッセージを送信できる (スレッドの場合はスレッドで送信できる) メンバーのみ登録できます
- ロールへのメンションは、メンション可能なロールか、通知先で `MENTION_EVERYONE` を持つ場合のみ指定できます。`@everyone` は指定できません
- 編集・削除・一時停止・再開は、登録者と `MANAGE_MESSAGES` を持つメンバーが行えます
- 有効なリマインダは 1 人 25 件、1 サーバー 500 件までです

#### 送信に失敗した場合

- Bot には通知先チャンネルの `VIEW_CHANNEL` と `SEND_MESSAGES` (スレッドの場合は `SEND_MESSAGES_IN_THREADS`) が必要です
- 一時的なエラー (5xx・レート制限) は自動で再試行します
- チャンネルの削除や権限不足で送信できない場合、そのリマインダは `⚠️ エラー` 状態になり停止します。`/remind list` で確認し、権限を直してから `/remind resume`、または `/remind edit` で通知先を変更してください
- Cron が遅れた場合、遅れて送る通知には「（予定 HH:MM から遅延）」と表示されます。本通知の時刻を過ぎた事前通知は送りません

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

### 3. D1 データベースの作成 (リマインダ)

リマインダは Cloudflare D1 (バインディング名 `REMINDER_DB`) に保存します。初回のみデータベースを作成し、表示された `database_id` を `wrangler.jsonc` の `d1_databases` (トップレベルと `previews` の 2 箇所) に設定してください。

```bash
pnpm exec wrangler d1 create funya-ojisan-reminder
pnpm cf-typegen
```

スキーマは `migrations/` で管理しています。ローカル (`pnpm dev` 用) と本番のそれぞれに適用します。

```bash
# ローカル
pnpm exec wrangler d1 migrations apply funya-ojisan-reminder --local
# 本番 (デプロイ前に実行)
pnpm exec wrangler d1 migrations apply funya-ojisan-reminder --remote
```

プレビュー環境用に D1 データベースを分離した場合 (`wrangler.jsonc` の `previews.d1_databases` に別の `database_id` を設定した場合) は、そのデータベースにも同じマイグレーションを適用してください。適用しないとテーブルが存在せず、プレビュー環境でリマインダを操作できません。

> [!WARNING]
> `wrangler d1 migrations apply` は、設定ファイルのトップレベルの `d1_databases` から対象を解決し、`previews` は参照しません。`wrangler.jsonc` のままプレビュー用のデータベース名を指定すると見つからずに失敗し、名前を変えずに ID だけを分離している場合は本番のデータベースに適用されます。

プレビュー用のデータベースをトップレベルに指定した、マイグレーション専用の設定ファイル (例: `wrangler.preview-d1.jsonc`。コミット不要) を作り、`--config` で指定して適用します。

```jsonc
// wrangler.preview-d1.jsonc
{
	"name": "funya-ojisan",
	"d1_databases": [
		{
			"binding": "REMINDER_DB",
			"database_name": "<プレビュー用のデータベース名>",
			"database_id": "<プレビュー用のデータベース ID>",
			"migrations_dir": "migrations"
		}
	]
}
```

```bash
pnpm exec wrangler d1 migrations apply <プレビュー用のデータベース名> --remote --config wrangler.preview-d1.jsonc
```

マイグレーションを追加した場合は、ローカル・本番 (・分離したプレビュー) のそれぞれに再度適用してください。適用済みのものはスキップされます。

### 4. スラッシュコマンドの登録

```bash
pnpm register
```

### 5. ローカル開発・動作確認

```bash
pnpm dev
```

リマインダの送信は毎分の Cron Trigger (`* * * * *`) で行います。ローカルで Cron を手動実行する場合は `--test-scheduled` を付けて起動し、`/__scheduled` にアクセスします。

```bash
pnpm exec wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

### 6. デプロイ (Cloudflare Workers)

本番環境用のシークレットを設定し、`wrangler.jsonc` の `vars.TARGET_CHANNEL_ID` と `kv_namespaces`（バインディング名 `PANEL_KV`）、`d1_databases`（バインディング名 `REMINDER_DB`）を確認し、D1 のマイグレーションを本番に適用したうえでデプロイします。

> [!IMPORTANT]
> すでに本番環境に `wrangler secret put TARGET_CHANNEL_ID` でシークレットを登録している場合、`wrangler.jsonc` の `vars.TARGET_CHANNEL_ID` と名前が衝突して `wrangler deploy` が失敗します。移行時は事前に `pnpm exec wrangler secret delete TARGET_CHANNEL_ID` を実行してください。
> また、`wrangler.jsonc` の `previews` ブロックでは Preview URL を Discord の Interactions Endpoint URL として登録しない前提で本番と同じ `TARGET_CHANNEL_ID` / `PANEL_KV` / `REMINDER_DB` の ID を指定しています。プレビュー環境で実動作テストを行う場合は、専用チャンネル・専用 KV Namespace・専用 D1 データベースに分離してください (プレビュー環境では Cron Trigger は実行されません)。

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
