# 2024-minicamp-mie-oauth
セキュリティ・ミニキャンプ in 三重 2024「OAuth 2.0を通じてWebアプリケーションで生じる脆弱性を学ぼう」の演習用アプリ

```bash
# ソースコードをgithubからダウンロード
$ git clone https://github.com/melonattacker/2024-minicamp-mie-oauth.git
$ cd 2024-minicamp-mie-oauth

# 演習用Webアプリの起動
$ cd web-app
$ docker compose up --build -d

# 演習用Webアプリの停止
$ docker compose down -v

# 演習用OAuthアプリの起動
$ cd oauth-app
$ docker compose up --build -d

# 演習用OAuthアプリの停止
$ docker compose down -v
```