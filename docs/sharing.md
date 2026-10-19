# 共有ライブラリ（Vercel ＋ Cloudflare R2）の設定手順

翻訳は各自のPCのローカルアプリで行い、公開された論文を友達がWebで閲覧できるようにする仕組みです。この手順は、管理する人が最初に1回だけ行います。

- 閲覧用Webアプリ: Vercel（このリポジトリの `public/` と `api/`）
- ファイルの保存先: Cloudflare R2（非公開のバケット）
- 閲覧: 共通パスワードでログインした人だけ
- 公開: 個別に渡した「公開用トークン」を持つ人だけ

## 1. Cloudflare R2

1. Cloudflare のダッシュボードで R2 を有効にし、バケットを1つ作る（例: `paper-library`）。公開アクセス（Public access）は**有効にしない**。
2. 「R2 API トークン」を作る。権限は「Object Read & Write」、対象は作ったバケットだけ。表示される **Access Key ID** と **Secret Access Key** を控える（Secret は一度しか表示されない）。
3. ダッシュボードに表示される **Account ID** を控える。
4. バケットの設定 → CORS ポリシーに次を貼る（`<your-app>` は後で決まる Vercel のドメイン。手元で `vercel dev` を試すなら `http://localhost:3000` も残す）。

```json
[
  {
    "AllowedOrigins": ["https://<your-app>.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range"],
    "ExposeHeaders": ["Content-Range", "Accept-Ranges", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

PDF は Vercel を経由せず、ブラウザが R2 から直接取得します。日本語PDF（十数MB）が、Vercel の関数が1回で返せる量（約4.5MB）を超えるためです。CORS は、その直接取得をこのアプリのページにだけ許可する設定です。`range` は、PDFを部分ごとに読み込んで最初のページを早く表示するために使います。

## 2. Vercel

1. このリポジトリを Vercel にインポートする（または、このフォルダで `vercel` コマンドを実行する）。ビルドの設定は `vercel.json` に書いてあるので変更不要。`data/` と `config.local.json` は `.vercelignore` で除外されるので、手元の翻訳データはアップロードされない。
2. Environment Variables に次を設定する。

| 名前 | 値 |
|---|---|
| `R2_ACCOUNT_ID` | 1-3 で控えた Account ID |
| `R2_ACCESS_KEY_ID` | 1-2 の Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 1-2 の Secret Access Key |
| `R2_BUCKET` | バケット名（例: `paper-library`） |
| `VIEW_PASSWORD` | 閲覧用の共通パスワード |
| `SESSION_SECRET` | ログイン状態の署名に使う長いランダム文字列（`openssl rand -hex 32` などで作る） |
| `UPLOAD_TOKENS` | 公開できる人の一覧。`名前:トークン` をカンマ区切り（例: `kenta:xxxx,tanaka:yyyy`）。トークンは `openssl rand -hex 24` などで人ごとに作る |

3. デプロイしたら、表示されたドメインを 1-4 の CORS の `AllowedOrigins` に入れる。

## 3. 友達に渡すもの

- **閲覧だけの人**: Web の URL と `VIEW_PASSWORD`
- **翻訳して公開もする人**: 上に加えて、本人用のトークンと、`docs/translator-setup.md` の手順

## 運用メモ

- 1論文あたり約30MB（原文PDF＋日本語PDF＋JSON）。R2 の無料枠 10GB で約300本が目安。
- パスワードが漏れたら `VIEW_PASSWORD` と `SESSION_SECRET` を変えて再デプロイする（全員が再ログインになる）。
- 特定の人の公開を止めるには、`UPLOAD_TOKENS` からその人を消して再デプロイする。
- 共有してよいかは論文のライセンス次第。改変禁止（ND）のライセンスでは、翻訳の共有が認められない場合がある。
