# .devcontainer/Dockerfile
FROM ubuntu:24.04

# 非対話モード設定
ENV DEBIAN_FRONTEND=noninteractive

# --- 基本ツールのインストール (Ignite CLIのインストールスクリプトに必要) ---
# Featuresのインストールはビルドの後に行われるため、
# ここで最低限の curl や git は入れておく必要があります。
RUN apt-get update && apt-get install -y --no-install-recommends \
	bash make curl git ca-certificates gnupg lsb-release \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Just (Command Runner) ---
# 公式インストールスクリプトを使用
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin

# --- Ignite CLI (Featureがないため手動インストール) ---
RUN curl -sSfL https://get.ignite.com/cli! | bash
