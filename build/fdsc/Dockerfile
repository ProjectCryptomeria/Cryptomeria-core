# 変更点: ベースイメージを軽量な debian:bookworm-slim に変更
FROM debian:bookworm-slim

# --- 依存パッケージのインストール ---
# ca-certificates, curl, jq に加え、
# useraddで使用する /bin/bash と procps (プロセス管理ツール) を追加インストールします。
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates curl jq bash procps \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*
	
RUN groupadd fdsc && useradd fdsc -g fdsc -s /bin/bash

# ローカルでビルドしたバイナリをコピー
COPY dist/fdscd /usr/bin/fdscd

# ユーザーを切り替え
USER fdsc

CMD ["fdscd"]