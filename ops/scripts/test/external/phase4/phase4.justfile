set shell := ["bash", "-c"]

# default: コマンド一覧を表示
_default:
    @just -l test phase4

# =============================================================================
# 📦 Phase 4: Advanced Upload Tests
# =============================================================================

# [4-1] HTML単体テスト (Index.html)
html:
    @./01-single-html.sh

# [4-2] ディレクトリ階層テスト (Recursive)
dir:
    @./02-directory.sh

# [4-3] Zipアーカイブテスト (Compression & Restoration)
zip:
    @./03-zip-archive.sh

# [4-4] 分散保存テスト (Sharding)
sharding:
    @./04-sharding.sh

# [All] 全てのPhase4テストを一括実行
all: html dir zip sharding