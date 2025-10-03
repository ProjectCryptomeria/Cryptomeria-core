# ベースイメージ
FROM ubuntu:24.04

# 開発用の非rootユーザーを作成 (UID/GIDを固定)
ARG UID=1000
ARG GID=1000
# GID 1000のグループが存在しない場合のみ、"ubuntu"という名前でグループを作成
RUN if ! getent group $GID > /dev/null; then groupadd -g $GID ubuntu; fi && \
    # UID 1000のユーザーが存在しない場合のみ作成
    if ! getent passwd $UID > /dev/null; then useradd -u $UID -g $GID -ms /bin/bash ubuntu; fi

# ホストのdocker group IDを受け取るための引数
ARG DOCKER_GID=999
# ホストのGIDでdockerグループを作成し、ubuntuユーザーをそのグループに追加する
RUN if ! getent group $DOCKER_GID > /dev/null; then groupadd -g $DOCKER_GID docker; fi && \
    usermod -aG docker ubuntu

# 環境変数を設定 (Goのパスとキャッシュディレクトリを明示的に定義)
ENV GOPATH=/go
ENV GOCACHE=/go/cache
ENV PATH=$GOPATH/bin:/usr/local/go/bin:$PATH
ENV KUBECONFIG=/home/ubuntu/.kube/config

# --- Goのバージョンを定義 ---
ARG GO_VERSION=1.25.1

# --- パッケージインストール (レイヤーキャッシュを効かせるために分割) ---

# レイヤー1: パッケージリストの更新
RUN apt-get update

# レイヤー2: 基本ツールのインストール
RUN apt-get install -y --no-install-recommends \
    bash make curl git openssl sudo time xxd jq just \
    docker.io ca-certificates

# レイヤー: Node.js (LTS) と yarn のインストール
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
RUN apt-get install -y nodejs
RUN corepack enable
RUN corepack prepare yarn@stable --activate

# レイヤー3: 後片付け (イメージサイズ削減)
RUN apt-get clean && rm -rf /var/lib/apt/lists/*

# --- ツールインストール ---

# レイヤー4: Go言語のインストール (PPAを使わず公式バイナリから直接インストール)
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o go.tar.gz && \
    tar -C /usr/local -xzf go.tar.gz && \
    rm go.tar.gz

# Helmをインストール
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# kubectlをインストール
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    install -m 0755 kubectl /usr/local/bin/kubectl && \
    rm kubectl

# Ignite CLIをインストール
RUN curl -sSfL https://get.ignite.com/cli! | bash

# 作業ディレクトリとキャッシュ用のディレクトリを作成し、所有権をubuntuユーザーに与える
WORKDIR /workspace
RUN mkdir -p /go/cache /go/pkg/mod  && \
    chown -R ubuntu:ubuntu /go /workspace

# ユーザーを切り替え
USER ubuntu

# デフォルトコマンド
CMD [ "bash" ]