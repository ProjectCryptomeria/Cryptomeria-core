#!/bin/bash
# エラーが発生したら即座にスクリプトを終了する
set -e

echo "🔧 Starting Kubernetes configuration setup..."

# 1. .kubeディレクトリの所有権を修正
# Dockerのマウント時にrootになる場合があるため、ubuntuユーザーに変更します
if [ -d "/home/ubuntu/.kube" ]; then
    echo "  - Fix permissions for .kube directory..."
    sudo chown -R ubuntu:ubuntu /home/ubuntu/.kube
fi

# 2. kubeconfigのコピー
# マウントされた読み取り専用の config.source を、書き込み可能な config にコピーします
if [ -f "/home/ubuntu/.kube/config.source" ]; then
    echo "  - Copying kubeconfig..."
    cp /home/ubuntu/.kube/config.source /home/ubuntu/.kube/config
    # セキュリティのため、パーミッションを所有者のみ読み書き可能に設定
    chmod 600 /home/ubuntu/.kube/config
else
    echo "⚠️ Warning: /home/ubuntu/.kube/config.source not found. Skipping config copy."
fi

# 3. 接続先アドレスの置換
# ホスト側の localhost (127.0.0.1) はコンテナ内では自分自身を指すため、
# 特殊なDNS名 host.docker.internal に書き換えます。ポート番号は動的なので維持します。
if [ -f "/home/ubuntu/.kube/config" ]; then
    echo "  - Updating server address in kubeconfig..."
    sed -i 's|server: https://127.0.0.1:|server: https://host.docker.internal:|g' /home/ubuntu/.kube/config

    # 4. TLS検証のスキップ設定
    # ホスト名が変わるため、証明書エラーを回避するためにTLS検証を無効化します
    echo "  - Setting insecure-skip-tls-verify..."
    kubectl config set-cluster docker-desktop --insecure-skip-tls-verify=true
fi

echo "✅ Kubernetes configuration setup completed."