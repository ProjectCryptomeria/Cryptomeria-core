#!/bin/bash

# エラーが発生したら即終了する設定
set -e

echo "🔧 Starting Kubernetes configuration setup..."

# 1. .kube ディレクトリの作成
mkdir -p "$HOME/.kube"

# 2. 設定ファイルのコピー
if [ -d "/tmp/kube-config-sync" ]; then
    echo "📂 Copying kube config from mounted volume..."
    cp -r /tmp/kube-config-sync/* "$HOME/.kube/"
    
    # --network=host を使うため、localhost (127.0.0.1) のままで接続可能です。
    # そのため、sed による host.docker.internal への書き換えは削除しました。
    
    echo "✅ Kubernetes configuration setup completed."
else
    echo "⚠️ Warning: /tmp/kube-config-sync not found. Skipping config copy."
fi