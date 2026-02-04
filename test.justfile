set shell := ["bash", "-c"]

# --- モジュール読み込み ---
# Phase4のテスト群をサブモジュールとして取り込む
mod phase4 "./ops/scripts/test/external/phase4/phase4.justfile"

_default:
	@just -l test

# =============================================================================
# 🧪 Testing
# =============================================================================

# [E2E] 最新の統合テスト (Upload -> Relay -> Verify)
e2e:
    @./ops/scripts/test/external/phase3-e2e-test.sh

# [Verify] ストレージに保存されたデータの構造確認と復元を行う
verify:
    @./ops/scripts/test/poc/stage4-verification.sh

# [Legacy] 旧アップロードテスト（互換性のため維持）
upload:
    @echo "--> 📤 Uploading test data (Legacy)..."
    @./ops/scripts/test/poc/upload-test.sh

# [Legacy] 旧ダウンロードテスト（互換性のため維持）
download:
    @echo "--> 📥 Downloading test data (Legacy)..."
    @./ops/scripts/test/poc/download-test.sh

# [Poc] 特定のプロセステストを実行（旧 test コマンド相当）
poc name:
    @echo "--> 🧪 Running {{name}}-test process..."
    @# ここで具体的なスクリプトを呼ぶか、引数に応じて分岐
    @if [ -f "./ops/scripts/test/poc/{{name}}-test.sh" ]; then \
        ./ops/scripts/test/poc/{{name}}-test.sh; \
    else \
        echo "❌ Test script for {{name}} not found."; \
        exit 1; \
    fi

# [debug] 特定のプロセステストを実行（旧 test コマンド相当）
debug name:
    @echo "--> 🧪 Running {{name}}-test process..."
    @# ここで具体的なスクリプトを呼ぶか、引数に応じて分岐
    @if [ -f "./ops/scripts/test/debug/{{name}}.sh" ]; then \
        ./ops/scripts/test/debug/{{name}}.sh; \
    else \
        echo "❌ Test script for {{name}} not found."; \
        exit 1; \
    fi

# =============================================================================
# 🚀 Performance Tests
# =============================================================================

# [Performance] パフォーマンステストを実行します
# usage: just test performance (全実行)
#        just test performance i (対話モード)
#        just test performance only="test_01*" (フィルタ実行)
performance arg="":
    @if [ "{{arg}}" == "i" ] || [ "{{arg}}" == "interactive" ]; then \
        ./ops/scripts/test/performance_test/run.sh --interactive; \
    elif [ -n "{{arg}}" ]; then \
        ./ops/scripts/test/performance_test/run.sh --only "{{arg}}"; \
    else \
        ./ops/scripts/test/performance_test/run.sh; \
    fi

# =============================================================================
# 🚀 Experiment Tests
# =============================================================================

exam arg="":
    #!/usr/bin/env bash
    set -e
    cd ./ops/scripts/experiment
    if [ "{{arg}}" == "1" ]; then 
        deno task exp --case 1; 
        exit 0;
    elif [ "{{arg}}" == "2" ]; then
        deno task exp --case 2; 
        exit 0;
    elif [ "{{arg}}" == "3" ]; then
        deno task exp --case 3;
        exit 0;
    fi

manual path project version numFdscChains="0":
    #!/usr/bin/env bash
    set -e
    cd ./ops/scripts/experiment
    deno task manual --path "{{path}}" --project "{{project}}" --version "{{version}}" --numFdscChains "{{numFdscChains}}"

monitor arg="30":
    #!/usr/bin/env bash
    set -e
    cd ./ops/scripts/experiment
    deno task monitor --duration "{{arg}}"