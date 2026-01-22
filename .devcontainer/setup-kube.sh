#!/bin/bash
# エラーが発生したら即座にスクリプトを終了する
set -e

echo "🔧 Starting Kubernetes configuration setup..."

# 定数定義：マウント元と配置先
SOURCE_CONFIG="/tmp/kube-config-source"
DEST_DIR="/home/ubuntu/.kube"
DEST_CONFIG="${DEST_DIR}/config"

# 1. .kubeディレクトリの作成
# マウントポイントを移動したため、ここでディレクトリを作成すれば
# 現在のユーザー(ubuntu)の権限で作成されます。chownは不要になります。
if [ ! -d "${DEST_DIR}" ]; then
    echo "  - Creating .kube directory..."
    mkdir -p "${DEST_DIR}"
    chmod 700 "${DEST_DIR}"
fi

# 2. kubeconfigのコピー
# 一時マウントされたソースから、書き込み可能な config にコピーします
if [ -f "${SOURCE_CONFIG}" ]; then
    echo "  - Copying kubeconfig from temp mount..."
    cp "${SOURCE_CONFIG}" "${DEST_CONFIG}"
    
    # セキュリティのため、パーミッションを所有者のみ読み書き可能に設定
    chmod 600 "${DEST_CONFIG}"
else
    echo "⚠️ Warning: ${SOURCE_CONFIG} not found. Skipping config copy."
    # configがない場合は後続の処理が無意味なので正常終了させる
    exit 0
fi

# 3. 接続先アドレスの置換
# ホスト側の localhost (127.0.0.1) はコンテナ内では自分自身を指すため、
# 特殊なDNS名 host.docker.internal に書き換えます。
if [ -f "${DEST_CONFIG}" ]; then
    echo "  - Updating server address in kubeconfig..."
    sed -i 's|server: https://127.0.0.1:|server: https://host.docker.internal:|g' "${DEST_CONFIG}"

    # 4. TLS検証のスキップ設定
    # ホスト名が変わるため、証明書エラーを回避するためにTLS検証を無効化します
    echo "  - Setting insecure-skip-tls-verify..."
    # kubectlがパスに通っているか確認し、念の為絶対パス指定などを検討してもよいが、
    # featuresで入れているため通常はパスが通っているはず
    kubectl config set-cluster docker-desktop --insecure-skip-tls-verify=true
fi

echo "✅ Kubernetes configuration setup completed."