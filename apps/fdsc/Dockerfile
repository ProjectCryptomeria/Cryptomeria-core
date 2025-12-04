# 変更点: ベースイメージを軽量な debian:bookworm-slim に変更
FROM debian:bookworm-slim

# --- 依存パッケージのインストール ---
# ca-certificates, curl, jq に加え、
# useraddで使用する /bin/bash と procps (プロセス管理ツール) を追加インストールします。
# killall コマンドを使うために psmisc を追加
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates curl jq bash procps psmisc \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

# ユーザーを作成 (ホームディレクトリ -m も作成)
RUN groupadd fdsc && useradd fdsc -g fdsc -s /bin/bash -m

# ユーザーを切り替え
USER fdsc
WORKDIR /home/fdsc

# ローカルでビルドしたバイナリをユーザーのホームディレクトリ配下のbinにコピー
# --chown を指定して、fdscユーザーが書き込み権限を持つようにする
COPY --chown=fdsc:fdsc ./dist/fdscd /home/fdsc/bin/fdscd

# PATHを通す
ENV PATH="/home/fdsc/bin:${PATH}"
