# --- Stage 1: relayerバイナリを取得 ---
# v2.6.0のイメージを指定
FROM ghcr.io/cosmos/relayer:v2.6.0 AS builder

# --- Stage 2: 最終的なイメージを構築 ---
# gwcdバイナリ(Debianベースでビルド)との互換性のため、Debianを使用
# これにより、k8s Jobなどを使わずともこのコンテナ内でgwcdが動作します
FROM debian:bookworm-slim

# --- 必要なパッケージをインストール ---
# ca-certificates: HTTPS通信用
# curl: kubectlダウンロードおよび接続確認用
# jq: JSON解析用
# procps: プロセス管理用
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates curl jq procps \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

# --- kubectlバイナリを直接ダウンロードしてインストール ---
# チェーンのステータス確認などに使用
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
	chmod +x ./kubectl && \
	mv ./kubectl /usr/bin/kubectl

# --- relayerバイナリをコピー ---
COPY --from=builder /bin/rly /usr/bin/rly

# --- gwcdバイナリをコピー (Tx発行用) ---
# gwcd をコピーします
# これにより、リレイヤーコンテナが「GWCのリモコン」としての機能も持ちます
COPY gwcd /usr/bin/gwcd

# --- 非rootユーザーを作成・設定 ---
RUN groupadd -r relayer && useradd -r -g relayer -m -d /home/relayer relayer
USER relayer
WORKDIR /home/relayer

# このDockerfileはスクリプト実行用なので、ENTRYPOINTは設定しない
CMD ["/bin/bash"]