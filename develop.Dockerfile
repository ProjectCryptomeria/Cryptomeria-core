# ベースイメージをUbuntuに変更します
FROM ubuntu:24.04

# 環境変数を設定
ENV KUBECONFIG=/root/.kube/config

# 必要なパッケージをインストール
RUN apt-get update && apt-get install -y \
    bash \
    make \
    curl \
    git \
    docker.io \
    openssl \
    sudo \
    software-properties-common

RUN add-apt-repository ppa:longsleep/golang-backports 
RUN apt-get update 
RUN apt-get install golang-go -y
    
# Helmをインストール
RUN curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 && \
    chmod 700 get_helm.sh && \
    ./get_helm.sh && \
    rm get_helm.sh

# kubectlをインストール
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    install -m 0755 kubectl /usr/local/bin/kubectl && \
    rm kubectl

# kindをインストールする
RUN set -x && \
    [ $(uname -m) = x86_64 ] && curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.20.0/kind-linux-amd64 || \
    [ $(uname -m) = aarch64 ] && curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.20.0/kind-linux-arm64 && \
    chmod +x ./kind && \
    mv ./kind /usr/local/bin/kind

# Ignite CLIをインストール
RUN curl https://get.ignite.com/cli! | bash

# 作業ディレクトリを設定
WORKDIR /workspace

# デフォルトコマンド
CMD [ "bash" ]