# ベースイメージ
FROM ubuntu:24.04

# 環境変数を設定 (Goのパスとキャッシュディレクトリを明示的に定義)
ENV GOPATH=/go
ENV GOCACHE=/go/cache
ENV PATH=$GOPATH/bin:/usr/local/go/bin:$PATH
ENV KUBECONFIG=/root/.kube/config

# aptパッケージのインストールと後片付けを一つのRUN命令に集約
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    # 基本ツール
    bash \
    make \
    curl \
    git \
    openssl \
    sudo \
    time \
    # Docker-in-Docker用
    docker.io \
    # PPA追加とHTTPS通信に必要
    software-properties-common \
    ca-certificates \
    # ビルド高速化のためのファイル同期ツール
    rsync && \
    # Go言語をPPAからインストール
    add-apt-repository -y ppa:longsleep/golang-backports && \
    apt-get update && \
    apt-get install -y --no-install-recommends golang-go && \
    # 後片付け (イメージサイズ削減)
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Helmをインストール
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# kubectlをインストール
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    install -m 0755 kubectl /usr/local/bin/kubectl && \
    rm kubectl

# kindをインストール
RUN curl -Lo ./kind "https://kind.sigs.k8s.io/dl/v0.20.0/kind-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')-v0.20.0" && \
    chmod +x ./kind && \
    mv ./kind /usr/local/bin/kind

# Ignite CLIをインストール
RUN curl https://get.ignite.com/cli! | bash

# 作業ディレクトリとキャッシュ用のディレクトリを作成
WORKDIR /workspace
RUN mkdir -p /go/cache /go/pkg && chmod -R 777 /go

# デフォルトコマンド
CMD [ "bash" ]