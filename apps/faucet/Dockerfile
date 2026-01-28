# ビルドステージ
FROM node:20-alpine AS builder

# 必要なビルドツールをインストール
RUN apk add --no-cache git python3 make g++

WORKDIR /app

# リポジトリをクローン (cosmosブランチ)
RUN git clone -b cosmos https://github.com/ping-pub/faucet.git .

# ✅ Node.js 20のESM対応: インポート文に .js 拡張子を強制付加
# ✅ BigInt シリアライズ対応: JSON.stringify で BigInt を扱えるようにする
# ✅ CORS 対応: 'import cors' と 'app.use(cors())' を適切な場所に挿入
RUN sed -i "s/'\.\/checker'/'\.\/checker\.js'/g" faucet.js && \
    sed -i "s/'\.\/config'/'\.\/config\.js'/g" faucet.js && \
    sed -i "1i BigInt.prototype.toJSON = function() { return this.toString() };" faucet.js && \
    sed -i "/import express/a import cors from 'cors';" faucet.js && \
    sed -i "/const app = express()/a app.use(cors());" faucet.js

# ✅ 依存関係のインストールと CosmJS のアップグレード、および 'cors' パッケージの追加
RUN npm install --quiet && \
    npm install cors @cosmjs/stargate@^0.32.2 @cosmjs/proto-signing@^0.32.2 @cosmjs/crypto@^0.32.2 @cosmjs/encoding@^0.32.2 @cosmjs/tendermint-rpc@^0.32.2 --save

# 実行ステージ
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app /app
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