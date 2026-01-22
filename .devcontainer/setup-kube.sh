#!/bin/bash

# エラーが発生したら即終了する設定
set -e

echo "🔧 Starting Kubernetes configuration setup..."

# 1. .kube ディレクトリの作成
# 既に存在していてもエラーにならないように -p オプションを使用
mkdir -p "$HOME/.kube"

# 2. 設定ファイルのコピー
# /tmp/kube-config-sync は devcontainer.json でマウントされた一時領域
if [ -d "/tmp/kube-config-sync" ]; then
    echo "📂 Copying kube config from mounted volume..."
    cp -r /tmp/kube-config-sync/* "$HOME/.kube/"
else
    echo "⚠️ Warning: /tmp/kube-config-sync not found. Skipping config copy."
fi

# 3. 接続先アドレスの書き換え
# コンテナ内からホストOSのKubernetesに接続するため、localhost を host.docker.internal に置換
echo "🔄 Updating kube config to use host.docker.internal..."
if [ -f "$HOME/.kube/config" ]; then
    sed -i -e 's/localhost/host.docker.internal/g' \
           -e 's/127.0.0.1/host.docker.internal/g' \
           "$HOME/.kube/config"
    
    # 4. TLS検証スキップの設定
    # ホスト名が変更されるため、証明書エラーを無視する設定を追加
    kubectl config set-cluster docker-desktop --insecure-skip-tls-verify=true
    
    echo "✅ Kubernetes configuration setup completed."
else
    echo "⚠️ Warning: $HOME/.kube/config not found."
fi