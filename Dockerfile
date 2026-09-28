# Railway/DockerでHaxeコンパイルサーバーを動かすためのイメージ。
# Debianベースのnodeイメージにaptで直接haxeとnekoを入れる。
FROM node:20-bookworm

# haxe: コンパイラ本体 / neko: haxeの一部機能が依存する実行ランタイム
RUN apt-get update \
    && apt-get install -y --no-install-recommends haxe neko \
    && rm -rf /var/lib/apt/lists/*

# インストール確認（ビルド時にコケたらここで気づける）
RUN haxe -version

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Railwayは環境変数 PORT を自動で注入する。server.js側は process.env.PORT を見ているのでそのままでOK
EXPOSE 8080

CMD ["node", "server.js"]
