# --- Stage 1: relayerバイナリを取得 ---
# v2.6.0のイメージを指定
FROM ghcr.io/cosmos/relayer:v2.6.0 AS builder

# --- Stage 2: 最終的なイメージを構築 ---
# シェルや各種ツールが使える軽量なalpineイメージをベースにする
FROM alpine:3.18

# --- 必要なパッケージをインストール ---
RUN apk update && apk add --no-cache jq curl
# --- kubectlバイナリを直接ダウンロードしてインストール ---
# 最新の安定版kubectlをダウンロードし、実行権限を与えてパスの通った場所に移動
RUN KUBECTL_VERSION=$(curl -L -s https://dl.k8s.io/release/stable.txt) && \
    curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" && \
    chmod +x ./kubectl && \
    mv ./kubectl /usr/bin/kubectl

# --- relayerバイナリをコピー ---
COPY --from=builder /bin/rly /usr/bin/rly

# --- 非rootユーザーを作成・設定 ---
# 元イメージのデフォルトユーザー名と合わせる
RUN addgroup -S relayer && adduser -S relayer -G relayer
USER relayer
WORKDIR /home/relayer

# このDockerfileはスクリプト実行用なので、ENTRYPOINTは設定しない