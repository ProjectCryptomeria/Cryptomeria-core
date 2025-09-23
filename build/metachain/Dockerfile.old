# --- ビルダーステージ ---
# Goのビルド環境と必要なツールを準備するステージ
FROM ubuntu:22.04 AS builder

# ビルドに必要なパッケージをインストール
# GoとIgnite CLIのインストールに必要なツールをまとめる
RUN apt-get update && apt-get install -y curl git make && rm -rf /var/lib/apt/lists/*

# Goをインストール
ENV GO_VERSION=1.24.6
RUN curl -L "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# Ignite CLIをインストール
RUN curl -sSfL https://get.ignite.com/cli! | bash
ENV PATH="/root/go/bin:${PATH}"

# 作業ディレクトリを設定
WORKDIR /app

# --- datachainの雛形をDockerfile内で動的に生成する ---
RUN ignite scaffold chain metachain --skip-git --default-denom uatom --skip-proto
WORKDIR /app/metachain
RUN mkdir -p ./proto && \
	echo "version: v2\nplugins: []" > ./proto/buf.gen.swagger.yaml
RUN ignite scaffold module metastore --ibc --dep bank --yes
RUN ignite scaffold packet metadata url:string addresses:array.string --module metastore --yes
RUN ignite scaffold map stored-meta url:string --module metastore --signer creator --yes

RUN sed -i 's/"metastore-1"/"ibc-proto-1"/g' x/metastore/types/keys.go

# --- datachaind バイナリをビルド ---
# ignite chain build コマンドは $GOPATH/bin にバイナリを生成する
# この場合、コンテナ内のGoのデフォルトのGOPATHは /root/go であるため、
# バイナリは /root/go/bin/datachaind に生成される
RUN ignite chain build

# --- 最終ステージ ---
# 実行に必要な最小限の環境を構築するステージ
FROM alpine:3.19

# セキュリティ向上のため、専用の非rootユーザーを作成
RUN addgroup -S metachain && adduser -S metachain -G metachain

# パスを /root/go/bin/datachaind に修正
COPY --from=builder /root/go/bin/metachaind /usr/bin/metachaind

# datachaind を実行ユーザーに実行権限を付与
RUN chmod +x /usr/bin/metachaind

# ユーザーを切り替え
USER metachain

# デフォルトのコマンドとしてmetachaindを設定
CMD ["metachaind"]