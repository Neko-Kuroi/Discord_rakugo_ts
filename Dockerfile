FROM node:20-slim

# better-sqlite3 のビルドに必要なツール + SQLite 最新版
RUN apt-get update && apt-get install -y \
    python3 make g++ wget build-essential \
    && wget https://www.sqlite.org/2024/sqlite-autoconf-3460100.tar.gz \
    && tar xzf sqlite-autoconf-3460100.tar.gz \
    && cd sqlite-autoconf-3460100 \
    && ./configure --prefix=/usr/local \
    && make && make install \
    && cd .. && rm -rf sqlite-autoconf-3460100* \
    && ldconfig \
    && apt-get remove -y wget build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# better-sqlite3 が新しい SQLite を使うように設定
ENV LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH

WORKDIR /code

COPY package*.json ./
RUN npm ci --production=false

COPY . .
RUN npm run build
RUN npm prune --production

CMD ["node", "dist/index.js"]