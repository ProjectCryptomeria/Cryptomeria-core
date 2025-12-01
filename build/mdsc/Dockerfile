# 実行に必要な最小限の環境としてAlpineを使用
FROM alpine:3.19

# ca-certificatesをインストール
RUN apk add --no-cache ca-certificates curl jq

# セキュリティ向上のため、専用の非rootユーザーを作成
RUN addgroup -S mdsc && adduser -S mdsc -G mdsc

# ローカルでビルドした静的バイナリをコピー
# このバイナリはCGO_ENABLED=0でビルドされたもの
COPY ./dist/mdscd /usr/bin/mdscd

# ユーザーを切り替え
USER mdsc

# デフォルトのコマンドとしてmdscdコマンドを設定
CMD ["mdscd"]