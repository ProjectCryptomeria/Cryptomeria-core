# test.just
set shell := ["bash", "-c"]

# =============================================================================
# 🧪 Testing
# =============================================================================

# [E2E] 最新の統合テスト (Upload -> Relay -> Verify)
e2e:
	@./ops/scripts/test/external/phase3-e2e-test.sh

# [Legacy] 旧アップロードテスト（互換性のため維持）
upload:
	@echo "--> 📤 Uploading test data (Legacy)..."
	@./ops/scripts/test/poc-upload-test.sh

# [Legacy] 旧ダウンロードテスト（互換性のため維持）
download:
	@echo "--> 📥 Downloading test data (Legacy)..."
	@./ops/scripts/test/poc-download-test.sh

# [Process] 特定のプロセステストを実行（旧 test コマンド相当）
process name:
	@echo "--> 🧪 Running {{name}}-test process..."
	@# ここで具体的なスクリプトを呼ぶか、引数に応じて分岐
	@if [ -f "./ops/scripts/test/{{name}}-test.sh" ]; then \
		./ops/scripts/test/{{name}}-test.sh; \
	else \
		echo "❌ Test script for {{name}} not found."; \
		exit 1; \
	fi