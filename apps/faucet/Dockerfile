# ビルドステージ
FROM node:20-alpine AS builder

# 必要なビルドツールをインストール
RUN apk add --no-cache git python3 make g++

WORKDIR /app

# リポジトリをクローン (cosmosブランチ)
RUN git clone -b cosmos https://github.com/ping-pub/faucet.git .

# ✅ Node.js 20のESM対応: インポート文に .js 拡張子を強制付加
RUN sed -i "s/'\.\/checker'/'\.\/checker\.js'/g" faucet.js && \
    sed -i "s/'\.\/config'/'\.\/config\.js'/g" faucet.js

# ✅ 依存関係のインストールと CosmJS のアップグレード (v0.32.x)
# これにより CometBFT の RPC レスポンスを正しく処理できるようになります
RUN npm install --quiet && \
    npm install @cosmjs/stargate@^0.32.2 @cosmjs/proto-signing@^0.32.2 @cosmjs/crypto@^0.32.2 @cosmjs/encoding@^0.32.2 @cosmjs/tendermint-rpc@^0.32.2 --save

# 実行ステージ
FROM node:20-alpine

WORKDIR /app

# ビルド成果物をコピー
COPY --from=builder /app /app

# ポートの公開 (values.yamlで指定した4500に合わせる)
EXPOSE 4500

# 実行時に環境変数を config.js に注入するスクリプト
RUN echo '#!/bin/sh' > /app/entrypoint.sh && \
    echo 'if [ -f /config/config.js ]; then' >> /app/entrypoint.sh && \
    echo '    cp /config/config.js /app/config.js' >> /app/entrypoint.sh && \
    echo '    # config.js 内の MNEMONIC_PLACEHOLDER を環境変数 $MNEMONIC で置換' >> /app/entrypoint.sh && \
    echo '    sed -i "s/MNEMONIC_PLACEHOLDER/$MNEMONIC/g" /app/config.js' >> /app/entrypoint.sh && \
    echo 'fi' >> /app/entrypoint.sh && \
    echo 'exec npm start' >> /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]