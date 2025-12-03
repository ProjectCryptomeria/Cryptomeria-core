#!/bin/bash
set -e

# --- 引数のチェック ---
if [ "$#" -ne 2 ]; then
    echo "💥 Error: Incorrect number of arguments."
    echo "Usage: $0 <old-release-name> <new-release-name>"
    exit 1
fi

# --- 変数定義 ---
OLD_RELEASE=$1
NEW_RELEASE=$2
OLD_CHART_PATH="./k8s/helm/${OLD_RELEASE}"
NEW_CHART_PATH="./k8s/helm/${NEW_RELEASE}"
NAMESPACE="default" # 必要に応じて変更

# --- メイン処理 ---
echo "🔄 Checking status of release '${OLD_RELEASE}' in namespace '${NAMESPACE}'..."

# helm status コマンドでリリースがデプロイ済みかを確認
if helm status "$OLD_RELEASE" -n "$NAMESPACE" > /dev/null 2>&1; then
    # --------------------------------------------------------------------------
    # シナリオ1: リリースが稼働中の場合 (ダウンタイムゼロでのリネーム)
    # --------------------------------------------------------------------------
    echo "  ✅ Release '${OLD_RELEASE}' is currently deployed. Starting zero-downtime rename procedure."
    
    HELPERS_TPL="${OLD_CHART_PATH}/templates/_helpers.tpl"

    # --- STEP 1: サービス停止の防止 ---
    echo "  ➡️  Step 1/4: Preparing for traffic sharing..."
    sed -i.bak "s/app.kubernetes.io\/instance: {{ .Release.Name }}/# app.kubernetes.io\/instance: {{ .Release.Name }}/g" "$HELPERS_TPL"
    echo "     - Selector modified. Applying to old release '${OLD_RELEASE}'..."
    helm upgrade "$OLD_RELEASE" "$OLD_CHART_PATH" --namespace "$NAMESPACE"
    echo "     - Done."

    # --- STEP 2: 既存リソースの孤立 (Orphan) ---
    echo "  ➡️  Step 2/4: Annotating existing resources to be orphaned..."
    RESOURCES=$(kubectl get all,configmap,serviceaccount,role,rolebinding -n "$NAMESPACE" -l "app.kubernetes.io/instance=${OLD_RELEASE}" -o name)
    if [ -z "$RESOURCES" ]; then
        echo "     - No resources found for release '${OLD_RELEASE}'. Skipping annotation."
    else
        for RES in $RESOURCES; do
          echo "     - Annotating $RES..."
          kubectl annotate -n "$NAMESPACE" "$RES" meta.helm.sh/release-name="$NEW_RELEASE" --overwrite
          kubectl annotate -n "$NAMESPACE" "$RES" meta.helm.sh/release-namespace="$NAMESPACE" --overwrite
        done
    fi
    echo "     - Done."

    # --- ここでチャートのリネームと内部修正を行う ---
    echo "     - Renaming chart directory and updating internal references..."
    mv "$OLD_CHART_PATH" "$NEW_CHART_PATH"
    sed -i.bak "s/name: ${OLD_RELEASE}/name: ${NEW_RELEASE}/g" "${NEW_CHART_PATH}/Chart.yaml" && rm "${NEW_CHART_PATH}/Chart.yaml.bak"
    find "${NEW_CHART_PATH}/templates" -type f \( -name "*.yaml" -o -name "*.tpl" \) -exec sed -i.bak "s/${OLD_RELEASE}/${NEW_RELEASE}/g" {} +
    find "${NEW_CHART_PATH}/templates" -type f -name "*.bak" -delete
    
    # --- STEP 3: 新リリースによる養子縁組 (Adopt) ---
    echo "  ➡️  Step 3/4: Adopting resources with new release '${NEW_RELEASE}'..."
    helm install "$NEW_RELEASE" "$NEW_CHART_PATH" --namespace "$NAMESPACE"
    echo "     - Done. Now both releases co-exist."

    # --- STEP 4: 最終的な所有権の確定とクリーンアップ ---
    echo "  ➡️  Step 4/4: Finalizing ownership and cleaning up..."
    mv "${NEW_CHART_PATH}/templates/_helpers.tpl.bak" "${NEW_CHART_PATH}/templates/_helpers.tpl"
    echo "     - Selector restored. Applying to new release '${NEW_RELEASE}'..."
    helm upgrade "$NEW_RELEASE" "$NEW_CHART_PATH" --namespace "$NAMESPACE"
    echo "     - Deleting old release '${OLD_RELEASE}' history..."
    helm uninstall "$OLD_RELEASE" --namespace "$NAMESPACE" --no-hooks
    echo "     - Done."

else
    # --------------------------------------------------------------------------
    # シナリオ2: リリースが稼働していない場合 (オフラインでのリネーム)
    # --------------------------------------------------------------------------
    echo "  ℹ️  Release '${OLD_RELEASE}' is not deployed. Performing offline chart rename."

    # Step 1: ディレクトリの存在チェック
    if [ ! -d "$OLD_CHART_PATH" ]; then
        echo "💥 Error: Chart directory '${OLD_CHART_PATH}' not found."
        exit 1
    fi
    if [ -d "$NEW_CHART_PATH" ]; then
        echo "💥 Error: Target directory '${NEW_CHART_PATH}' already exists."
        exit 1
    fi

    # Step 2: ディレクトリとファイル内容をリネーム
    echo "  ➡️  Step 1/2: Renaming directory and updating files..."
    mv "$OLD_CHART_PATH" "$NEW_CHART_PATH"
    sed -i.bak "s/name: ${OLD_RELEASE}/name: ${NEW_RELEASE}/g" "${NEW_CHART_PATH}/Chart.yaml" && rm "${NEW_CHART_PATH}/Chart.yaml.bak"
    echo "     - Chart.yaml updated."
    find "${NEW_CHART_PATH}/templates" -type f \( -name "*.yaml" -o -name "*.tpl" \) -exec sed -i.bak "s/${OLD_RELEASE}/${NEW_RELEASE}/g" {} +
    find "${NEW_CHART_PATH}/templates" -type f -name "*.bak" -delete
    echo "     - Internal template references updated."
    echo "     - Done."

    echo "  ➡️  Step 2/2: Cleanup complete."
fi

echo "✅ Helm chart and release successfully renamed to '${NEW_RELEASE}'!"
echo "⚠️  IMPORTANT: Please manually update the APP_NAME and RELEASE_NAME variables in your Makefile to '${NEW_RELEASE}' for future commands."