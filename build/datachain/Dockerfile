# 実行に必要な最小限の環境としてAlpineを使用
FROM alpine:3.19

# ca-certificatesをインストール
RUN apk add --no-cache ca-certificates curl jq

# セキュリティ向上のため、専用の非rootユーザーを作成
RUN addgroup -S datachain && adduser -S datachain -G datachain

# ローカルでビルドした静的バイナリをコピー
# このバイナリはCGO_ENABLED=0でビルドされたもの
COPY ./dist/datachaind /usr/bin/datachaind

# ユーザーを切り替え
USER datachain

CMD ["datachaind"]