# Discord Bot 完全チュートリアル（TypeScript版）
## 〜 rakugo Bot で学ぶ discord.js v14・SQLite FTS5・Worker Threads・コンテナ運用 〜

> **本チュートリアルについて**  
> 落語YouTube検索Botを題材に、discord.js v14・SQLite FTS5・Expressヘルスチェック・
> 非同期処理・コンテナ運用を体系的に解説します。
> Python版チュートリアルとの対応関係を示しながら、TypeScriptならではの型安全な実装を学びます。

**技術スタック：** `discord.js v14` · `TypeScript 5.x` · `SQLite FTS5 trigram` · `Docker` · `better-sqlite3` · `Express` · `Node.js 20+`

---

## 目次

1. [アーキテクチャ概要](#1-アーキテクチャ概要)
2. [環境セットアップ](#2-環境セットアップ)
3. [エントリポイントと起動フロー](#3-エントリポイントと起動フロー)
4. [Botクラスの設計](#4-botクラスの設計)
5. [SQLite FTS5 仮想テーブル](#5-sqlite-fts5-仮想テーブル)
6. [非同期処理の考え方](#6-非同期処理の考え方)
7. [Pagination（ページネーション）](#7-paginationページネーション)
8. [スラッシュコマンドの実装](#8-スラッシュコマンドの実装)
9. [Discord Interaction ライフサイクル](#9-discord-interaction-ライフサイクル)
10. [コンテナ運用と Dockerfile](#10-コンテナ運用と-dockerfile)
11. [よくあるエラーとデバッグ](#11-よくあるエラーとデバッグ)
12. [まとめ・次のステップ](#12-まとめ次のステップ)
13. [付録：完全ソースコード](#13-付録完全ソースコード)

---

## 1. アーキテクチャ概要

### 1.1 全体構成

```
┌─────────────────────────────────────────────────────┐
│  Docker Container                                    │
│                                                      │
│  ┌─────────────────┐    ┌─────────────────────────┐ │
│  │  Express         │    │  Discord Bot             │ │
│  │  (port 7860)     │    │  (discord.js v14)        │ │
│  │  ヘルスチェック用 │    │  スラッシュコマンド処理   │ │
│  └────────┬────────┘    └────────────┬────────────┘ │
│           │  同一プロセス             │  EventEmitter  │
│           └──────────────────────────┘               │
│                         │                            │
│              ┌──────────┴──────────┐                 │
│              │  SQLite DB           │                 │
│              │  /code/rakugo.db     │                 │
│              │  ・videos テーブル   │                 │
│              │  ・videos_fts (FTS5) │                 │
│              └─────────────────────┘                 │
└─────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
   Hugging Face              Discord API
   (外部アクセス)            (WebSocket)
```

### 1.2 技術スタック対応表

| レイヤー | Python版 | TypeScript版 | 役割 |
|---|---|---|---|
| Botフレームワーク | `discord.py 2.x` | `discord.js v14` | Discord API通信 |
| Webサーバー | `FastAPI + uvicorn` | `Express` | ヘルスチェック |
| データベース | `sqlite3`（標準ライブラリ） | `better-sqlite3` | 動画データ永続化 |
| 全文検索 | FTS5 (trigram) | FTS5 (trigram) | 高速日本語検索 |
| 非同期処理 | `asyncio.to_thread` | `better-sqlite3`（同期）+ Promise | ノンブロッキングI/O |
| 型システム | 型ヒント（任意） | TypeScript（必須） | 型安全なコード |
| コンテナ | Docker | Docker | デプロイ環境 |

### 1.3 ファイル構成

```
/code/
├── src/
│   ├── types.ts      # VideoRow 型定義
│   ├── database.ts   # SQLite操作・FTS5初期化・検索関数
│   ├── deploy.ts     # スラッシュコマンド登録
│   └── index.ts      # Bot本体・イベントハンドラ・エントリポイント
├── dist/             # TypeScriptコンパイル後の出力先
├── rakugo.db
├── .env
├── tsconfig.json
├── package.json
└── Dockerfile
```

### 1.4 データフロー

```
ユーザーが /rakugo コマンド入力
    ↓
Discord → WebSocket → discord.js → interactionCreate
    ↓
鮮度チェック（2.5秒以上経過なら即 return）
    ↓
interaction.deferReply()  ← 3秒以内に必須
    ↓
searchVideos(keyword)     ← better-sqlite3（同期API）
    ↓
FTS5 trigram 検索 または LIKE 検索
    ↓
EmbedBuilder + ActionRowBuilder（Button/SelectMenu）を生成
    ↓
interaction.editReply()
    ↓
ユーザーに検索結果表示
```

---

## 2. 環境セットアップ

### 2.1 Node.js のインストール

discord.js v14 は **Node.js 16.11.0以上**、`better-sqlite3` のコンパイルには **Node.js 18+** を推奨します。本チュートリアルでは **Node.js 20 LTS** を前提とします。

```bash
node --version   # v20.x.x
npm --version    # 10.x.x
```

### 2.2 パッケージインストール

```bash
npm init -y

npm install discord.js better-sqlite3 dotenv express
npm install --save-dev typescript ts-node @types/node @types/better-sqlite3 @types/express
npx tsc --init
```

> **⚠️ better-sqlite3 のビルド要件**  
> `better-sqlite3` はネイティブアドオン（C++）です。  
> **Windows：** Visual Studio Build Tools  
> **macOS：** `xcode-select --install`  
> **Linux：** `build-essential` と `python3`  

### 2.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 2.4 package.json スクリプト

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev":   "ts-node src/index.ts"
  }
}
```

### 2.5 環境変数（.env）

```bash
BOT_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_application_client_id_here
DB_PATH=/code/rakugo.db
```

### 2.6 Discord Developer Portal での設定

- `Bot` スコープ
- `applications.commands` スコープ（スラッシュコマンド用）
- **Message Content Intent**（Bot設定ページで有効化）

---

## 3. エントリポイントと起動フロー

### 3.1 起動シーケンス

Python版では `setup_hook()` が「初回起動のみ実行される初期化の場所」でした。discord.js には `setup_hook` 相当の仕組みがないため、**`client.login()` の前に初期化処理をすべて完了させる** ことで同じ効果を得ます。

```typescript
// src/index.ts — 起動シーケンス（Python版の setup_hook に相当）
async function main(): Promise<void> {
    initFts();               // FTS5テーブル構築（DB初期化）
    await deployCommands();  // スラッシュコマンド同期
    await client.login(process.env.BOT_TOKEN!);
}

main().catch(err => {
    console.error('Critical Error:', err);
    process.exit(1);
});
```

**なぜ `login()` の前に初期化するのか：**

`client.on('ready')` はRESUME（再接続）時にも発火します。`ready` の中で `initFts()` や `deployCommands()` を呼ぶと、再接続のたびに重複実行されてしまいます。

| | Python版 | TypeScript版 |
|---|---|---|
| 初回起動のみ実行 | `setup_hook()` | `login()` の前 |
| RESUME時も実行 | `on_ready()` | `client.on('ready')` |
| DB初期化の場所 | `setup_hook()` | `login()` の前 |
| コマンド同期の場所 | `setup_hook()` | `login()` の前 |

### 3.2 on('ready') はログのみ

```typescript
client.once('ready', () => {
    // ここはログのみ。初期化処理は main() に書く
    console.log(`✅ Logged in as ${client.user?.tag}`);
});
```

### 3.3 シグナルハンドリング

Python版の `signal.signal(SIGTERM, stop_all)` に対応します。

```typescript
process.on('SIGINT',  () => { client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
```

> **🐍 Python版との比較**  
> Python版では `bot.loop.create_task(bot.close())` という書き方が必要でした
>（シグナルハンドラがイベントループ外で実行されるため）。  
> Node.js ではシグナルハンドラ内で `async/await` をそのまま使えます。

### 3.4 ヘルスチェックサーバー

HuggingFace Spaces などのホスティング環境では、定期的にHTTPでアクセスしてコンテナが生きているか確認します。

```typescript
// Python版の FastAPI に相当
const app = express();
app.get('/', (_req, res) => res.json({ status: 'running', bot: client.user?.tag ?? 'starting' }));
app.listen(7860, () => console.log('🌐 Health server on port 7860'));
```

---

## 4. Botクラスの設計

### 4.1 クライアントとインテント

Python版の `discord.Intents` に対応するのが `GatewayIntentBits` です。

```typescript
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,        // サーバー情報
        GatewayIntentBits.GuildMessages, // メッセージイベント
    ],
});
```

### 4.2 スラッシュコマンドの登録（deploy.ts）

Python版の `tree.sync()` に相当します。

```typescript
// src/deploy.ts
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

const commands = [
    new SlashCommandBuilder()
        .setName('rakugo')
        .setDescription('落語動画をキーワード検索します')
        .addStringOption(option =>
            option
                .setName('keyword')
                .setDescription('検索ワード（スペース区切りでAND検索）')
                .setRequired(true)
        ),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN!);

export async function deployCommands(): Promise<void> {
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID!),
            { body: commands },
        );
        console.log('✅ スラッシュコマンド同期完了');
    } catch (error) {
        console.error('コマンド同期エラー:', error);
    }
}
```

---

## 5. SQLite FTS5 仮想テーブル

### 5.1 FTS5とは何か

FTS5（Full-Text Search 5）はSQLiteに組み込まれた全文検索エンジンです。転置インデックスによってキーワード検索を高速に行います。

```sql
-- ❌ LIKE検索: 20万件を全てスキャン（遅い）
SELECT * FROM videos WHERE title LIKE '%三遊亭%';

-- ✅ FTS5検索: インデックスから直接検索（速い）
SELECT * FROM videos_fts WHERE videos_fts MATCH '"三遊亭"';
```

### 5.2 trigramトークナイザーと日本語

```
入力: "三遊亭圓生"

生成されるトークン:
  "三遊亭", "遊亭圓", "亭圓生"

検索 "三遊亭" → マッチ ✅
検索 "圓生"   → 2文字 → FTS5対象外 → LIKEにフォールバック
```

### 5.3 FTS5テーブルの初期化（database.ts）

```typescript
// src/database.ts
import Database from 'better-sqlite3';
import { VideoRow } from './types';

const DB_PATH = process.env.DB_PATH || 'rakugo.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // 書き込みパフォーマンス向上

export function initFts(): void {
    console.log(`📦 SQLite Version: ${db.prepare('SELECT sqlite_version()').pluck().get()}`);

    // DDL（DROP/CREATE）は SQLite では autocommit。transaction で囲む必要はない
    db.exec(`DROP TABLE IF EXISTS videos_fts`);
    db.exec(`
        CREATE VIRTUAL TABLE videos_fts USING fts5(
            title, super_title,
            content='videos', content_rowid='rowid',
            tokenize='trigram'
        )
    `);
    db.exec(`
        INSERT INTO videos_fts(rowid, title, super_title)
        SELECT rowid, title, super_title FROM videos
    `);
    // インデックスの断片化を解消して検索速度を向上
    db.exec(`INSERT INTO videos_fts(videos_fts) VALUES('optimize')`);

    console.log('✅ FTS5 index rebuilt and optimized.');
}
```

> **⚠️ なぜ毎回 DROP して再構築するのか**  
> コンテナ再デプロイ時にFTS5テーブルが中途半端な状態（1件だけ入っているなど）で残ることがあります。
> `IF NOT EXISTS` + 件数チェックではこのケースを検出できないため、
> 毎回 `DROP TABLE IF EXISTS` で確実に再構築します。

> **💡 `db.transaction` は不要**  
> FTS5仮想テーブルへの `DROP` / `CREATE` は DDL なので、
> SQLite では暗黙的に autocommit されます。
> `db.transaction()` で囲んでも意味がないため、素直に `db.exec()` を並べます。

### 5.4 FTS5 + LIKE ハイブリッド検索

```typescript
export function searchVideos(
    keyword: string,
    limit = 7,
    offset = 0
): { rows: VideoRow[], total: number } {
    // 全角スペースを半角に統一し、filter(Boolean) で空要素を排除
    const keywords = keyword.trim().replace(/　/g, ' ').split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return { rows: [], total: 0 };

    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const k of keywords) {
        // FTS5の MATCH 構文を壊すダブルクォートをサニタイズ
        const kClean = k.replace(/"/g, ' ').trim();
        if (!kClean) continue;

        if (kClean.length >= 3) {
            // 3文字以上 → FTS5（高速）。trigram ではフレーズクォートが必要
            conditions.push('v.rowid IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH ?)');
            params.push(`"${kClean}"`);
        } else {
            // 2文字以下 → LIKE にフォールバック
            conditions.push('(v.title LIKE ? OR v.super_title LIKE ?)');
            params.push(`%${kClean}%`, `%${kClean}%`);
        }
    }

    const whereClause = conditions.length ? conditions.join(' AND ') : '1=1';

    const total = db
        .prepare(`SELECT COUNT(*) FROM videos v WHERE ${whereClause}`)
        .pluck()
        .get(...params) as number;

    const rows = db.prepare(`
        SELECT title, super_title, video_url, view_count,
               channel_name, channel_url, publish_date, relative_date
        FROM videos v
        WHERE ${whereClause}
        ORDER BY
            CASE WHEN v.view_count IS NULL OR v.view_count = '' THEN 0
                 ELSE CAST(v.view_count AS INTEGER) END DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as VideoRow[];

    return { rows, total };
}
```

**なぜフレーズクォート（`"キーワード"`）が必要か：**

```
trigram で "三遊亭" を検索する場合：

クォートなし: 三遊亭
  → FTS5は "三"・"遊"・"亭" として解釈 → 意図しない結果

クォートあり: "三遊亭"
  → FTS5はフレーズとして解釈 → 正しい部分一致検索
```

### 5.5 content テーブルの仕組み

```
videos テーブル（実データ）
┌────────┬──────────────┬─────────────┐
│ rowid  │ title        │ super_title │
├────────┼──────────────┼─────────────┤
│ 1      │ 時そば       │ 古典落語    │
│ 2      │ 芝浜         │ 古典落語    │
│ 3      │ 三遊亭圓生名演│ 圓生百席    │
└────────┴──────────────┴─────────────┘

videos_fts 仮想テーブル（インデックスのみ）
  → content='videos'      で元テーブルを参照
  → content_rowid='rowid' で rowid を介して紐付け
  → 実データは videos 側に持つ（重複しない）
```

---

## 6. 非同期処理の考え方

### 6.1 better-sqlite3 は同期API

Python版では `asyncio.to_thread(_query)` で同期SQLite処理をスレッドに逃がす必要がありました。

`better-sqlite3` は意図的に**同期API**として設計されています。Promiseを返さず、`await` は不要です。

```typescript
// better-sqlite3 は同期（await 不要）
const rows = db.prepare('SELECT ...').all(...params) as VideoRow[];

// Python版（asyncio.to_thread が必要だった）
// rows = await asyncio.to_thread(_query)
```

### 6.2 なぜブロッキングが問題になるか

discord.js は Node.js の**単一イベントループ**で動作しています。

```
イベントループ（1本のスレッド）
    │
    ├── Discordのハートビート
    ├── コマンド処理
    └── ボタン押下の処理

ここで db.prepare().all() が数秒かかると：
    └── 他の処理が全て止まる → インタラクションが期限切れになる
```

### 6.3 今回の実装での対処

`better-sqlite3` はFTS5 trigram + インデックス最適化済みの場合、20万件でも**数十ミリ秒**で返ります。このため今回はブロッキングが実用上問題になりません。

重い処理が必要な場合は `worker_threads` モジュールで別スレッドに逃がします（Python版の `asyncio.to_thread` に相当）。

| 状況 | 対処 |
|---|---|
| FTS5検索（今回） | 同期のまま使用（数十ms） |
| 重いCPU処理 | `worker_threads` で別スレッド |
| 大量のI/O | `async` ドライバ（`better-sqlite3-multiple-ciphers` 等）を検討 |

---

## 7. Pagination（ページネーション）

### 7.1 discord.js の UI コンポーネント対応表

| Python (discord.py) | TypeScript (discord.js) |
|---|---|
| `discord.ui.View` | `ActionRowBuilder` でコンポーネントをまとめる |
| `discord.ui.Button` | `ButtonBuilder` |
| `discord.ui.Select` | `StringSelectMenuBuilder` |
| `@discord.ui.button()` デコレータ | `ButtonBuilder` + `customId` で識別 |
| `view.timeout = 300` | discord.js ではコレクターで管理 |

### 7.2 `buildComponents` 関数

```typescript
function buildComponents(
    keyword: string,
    page: number,
    total: number,
    rows: { title: string | null; super_title: string | null; video_url: string; channel_name: string | null }[]
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {

    // セレクトメニュー（詳細表示用）
    const select = new StringSelectMenuBuilder()
        .setCustomId('select_video')
        .setPlaceholder('詳細を見る動画を選択...')
        .addOptions(rows.map((r, i) => ({
            label: `${page * 7 + i + 1}. ${r.title || r.super_title || 'Untitled'}`.slice(0, 100),
            value: r.video_url,
            description: (r.channel_name ?? '').slice(0, 100),
        })));

    // ページングボタン
    // ⚠️ customId のデリミタは ':' を使用。'_' はキーワードに含まれる可能性があり衝突する
    const prevBtn = new ButtonBuilder()
        .setCustomId(`prev:${page}:${keyword}`)
        .setLabel('◀️ 前へ')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0);

    const nextBtn = new ButtonBuilder()
        .setCustomId(`next:${page}:${keyword}`)
        .setLabel('次へ ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * 7 >= total);

    return [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn),
    ];
}
```

### 7.3 customId によるコンポーネント識別

Python版では `view.callback` でコールバックを直接登録しました。discord.js では **customId** に状態を埋め込み、`interactionCreate` で分岐します。

```typescript
// customId の形式: "action:page:keyword"
//   例: "next:0:三遊亭"
//   例: "prev:2:三遊亭圓生"

// ボタンが押されたとき
if (interaction.isButton()) {
    // ⚠️ キーワード内に ':' が含まれる場合に備えて残余引数で結合する
    const [action, pageStr, ...keywordParts] = interaction.customId.split(':');
    const keyword = keywordParts.join(':');  // キーワードを安全に復元
    const currentPage = parseInt(pageStr, 10);
    ...
}
```

**なぜ `'_'` ではなく `':'` を使うのか：**

```
❌ '_' 区切りの問題：
  customId = "next_0_三遊亭_圓生"
  split('_') → ['next', '0', '三遊亭', '圓生']
  keyword = '三遊亭' だけになる（圓生が消える）

✅ ':' 区切り + 残余引数：
  customId = "next:0:三遊亭:圓生"
  [action, pageStr, ...keywordParts] = split(':')
  keyword = keywordParts.join(':') → '三遊亭:圓生'
  ※ キーワードに ':' が含まれていても安全に復元できる
```

---

## 8. スラッシュコマンドの実装

### 8.1 コマンドハンドラ

```typescript
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'rakugo') return;

    // RESUME後の古いインタラクションを弾く（Python版と同じ鮮度チェック）
    const ageMs = Date.now() - interaction.createdTimestamp;
    if (ageMs > 2_500) {
        console.warn(`Stale interaction skipped (${ageMs}ms old)`);
        return;
    }

    // 3秒以内に必ず deferReply する
    try {
        await interaction.deferReply();
    } catch {
        console.warn('Interaction expired before deferReply');
        return;
    }

    try {
        const keyword = interaction.options.getString('keyword', true);
        const { rows, total } = searchVideos(keyword, 7, 0);

        if (total === 0) {
            return void await interaction.editReply(`「${keyword}」に一致する落語は見つかりませんでした。`);
        }

        const embed = new EmbedBuilder()
            .setTitle(`🔍 「${keyword}」の検索結果`)
            .setColor(0xe85d3a)
            .setDescription(buildDescription(rows, 0))
            .setFooter({ text: `1 / ${Math.ceil(total / 7)} ページ（合計 ${total} 件）` });

        await interaction.editReply({
            embeds: [embed],
            components: buildComponents(keyword, 0, total, rows),
        });

    } catch (error) {
        console.error('Error in /rakugo:', error);
        try {
            await interaction.editReply('検索中にエラーが発生しました。もう一度試してください。');
        } catch { /* editReply 自体が失敗してもクラッシュしない */ }
    }
});
```

### 8.2 ボタン・セレクトメニューの処理

```typescript
// ページングボタン
if (interaction.isButton()) {
    const [action, pageStr, ...keywordParts] = interaction.customId.split(':');
    const keyword = keywordParts.join(':');
    const currentPage = parseInt(pageStr, 10);

    if (action !== 'prev' && action !== 'next') return;

    await interaction.deferUpdate(); // メッセージを編集（新規送信しない）

    const newPage = action === 'next' ? currentPage + 1 : currentPage - 1;
    const { rows, total } = searchVideos(keyword, 7, newPage * 7);

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setDescription(buildDescription(rows, newPage * 7))
        .setFooter({ text: `${newPage + 1} / ${Math.ceil(total / 7)} ページ（合計 ${total} 件）` });

    await interaction.editReply({
        embeds: [embed],
        components: buildComponents(keyword, newPage, total, rows),
    });
}

// セレクトメニュー（詳細表示）
if (interaction.isStringSelectMenu() && interaction.customId === 'select_video') {
    try {
        await interaction.deferReply({ ephemeral: true }); // 本人にだけ見える
    } catch {
        return;
    }

    const video = getVideoByUrl(interaction.values[0]);
    if (!video) {
        return void await interaction.followUp({ content: '詳細が見つかりませんでした。', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setTitle(video.title || video.super_title || 'Untitled')
        .setURL(video.video_url)
        .setColor(0xff0000)
        .addFields(
            { name: 'チャンネル', value: video.channel_name || '不明', inline: true },
            { name: '再生数',     value: `${video.view_count || 0} 回`,    inline: true },
            { name: '公開日',     value: video.publish_date || video.relative_date || '不明', inline: true },
        );

    await interaction.followUp({ embeds: [embed], ephemeral: true });
}
```

---

## 9. Discord Interaction ライフサイクル

### 9.1 タイムアウト構造

```
コマンド実行（ユーザーが /rakugo を入力）
    ↓
【3秒以内】 deferReply() または reply() が必要
    │  ↑ これを超えると Unknown Interaction (10062) エラー
    ↓
「考え中...」がDiscord側に表示される
    ↓
【15分以内】 editReply() で実際の返信
    ↓
ページングボタン・セレクトメニューが有効
```

### 9.2 インタラクションの種類と応答方法

| 種類 | Python (discord.py) | TypeScript (discord.js) |
|---|---|---|
| スラッシュコマンド | `response.defer()` → `followup.send()` | `deferReply()` → `editReply()` |
| ボタン押下 | `response.edit_message()` | `deferUpdate()` → `editReply()` |
| セレクト選択 | `response.defer(ephemeral=True)` → `followup.send()` | `deferReply({ephemeral:true})` → `followUp()` |

### 9.3 RESUME対策の鮮度チェック

```typescript
// Python版
// age = (utcnow() - interaction.created_at).total_seconds()
// if age > 2.5: return

// TypeScript版
const ageMs = Date.now() - interaction.createdTimestamp;
if (ageMs > 2_500) {
    console.warn(`Stale interaction skipped (${ageMs}ms old)`);
    return;
}
```

> **⚠️ RESUME後の古いインタラクション問題**  
> ネットワーク瞬断からRESUMEしたとき、Discordがバッファしていたインタラクションが再配信されます。
> 作成から2.5秒以上経過しているものは `deferReply()` が `10062 Unknown Interaction` で失敗するため、事前にスキップします。

---

## 10. コンテナ運用と Dockerfile

### 10.1 Dockerfile（SQLite最新版・better-sqlite3対応）

```dockerfile
# Node.js 20 LTS（Alpine は better-sqlite3 のビルドで問題が出やすいため slim を使用）
FROM node:20-slim

# better-sqlite3 のビルドに必要なツール + SQLite 最新版（trigram は 3.35.0以降）
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
```

### 10.2 docker-compose

```yaml
version: '3.8'
services:
  rakugo-bot:
    build: .
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./rakugo.db:/code/rakugo.db
    ports:
      - "7860:7860"
```

---

## 11. よくあるエラーとデバッグ

### 11.1 Unknown Interaction (10062)

```
DiscordAPIError[10062]: Unknown interaction
```

| 原因 | 対処 |
|---|---|
| RESUME後の古いインタラクション再配信 | `ageMs > 2_500` の鮮度チェック |
| `deferReply` の前にブロッキング処理 | `deferReply` をハンドラの先頭で呼ぶ |
| `deferReply` 自体が失敗 | `try/catch` で握りつぶす |

### 11.2 FTS5 検索で0件になる

```typescript
// 1. SQLiteバージョン確認（3.35.0以降が必要）
console.log(db.prepare('SELECT sqlite_version()').pluck().get());

// 2. FTS5テーブルのデータ件数確認
console.log(db.prepare('SELECT COUNT(*) FROM videos_fts').pluck().get());

// 3. フレーズクォートの確認
// NG: params.push(kClean)
// OK: params.push(`"${kClean}"`)

// 4. ダブルクォートのサニタイズ確認
const kClean = k.replace(/"/g, ' ').trim();
```

### 11.3 better-sqlite3 のビルドエラー

```bash
# エラー: gyp ERR! build error（Windowsの場合）
npm install --global windows-build-tools

# エラー: python3 not found（Linuxの場合）
apt-get install python3

# エラー: Node.jsバージョン不一致
npm rebuild better-sqlite3
```

### 11.4 customId の衝突

```
❌ 症状：ページングで keyword が途中で切れる

原因：customId の区切りに '_' を使っていて、
      キーワード内の '_' と衝突している

✅ 対処：':' を区切りに使い、残余引数で復元する
  const [action, pageStr, ...keywordParts] = customId.split(':');
  const keyword = keywordParts.join(':');
```

### 11.5 日本語特有のハマりどころ

```typescript
// ✅ 全角スペース（U+3000）を半角に統一
const keywords = keyword
    .replace(/　/g, ' ')   // 全角スペース → 半角
    .trim()
    .split(/\s+/)           // 連続スペースも1つに
    .filter(Boolean);       // 空文字を除去
```

---

## 12. まとめ・次のステップ

### 12.1 Python版 → TypeScript版 対応表

| テーマ | Python版 | TypeScript版 |
|---|---|---|
| 非同期SQL | `asyncio.to_thread(_query)` | `better-sqlite3`（同期）をそのまま使用 |
| FTS5初期化 | `create_fts_and_indexes()` | `initFts()` |
| UIコンポーネント | `discord.ui.View` | `ActionRowBuilder` |
| コマンド定義 | `@bot.tree.command` | `SlashCommandBuilder` + `deployCommands()` |
| インテント | `discord.Intents` | `GatewayIntentBits` |
| Webサーバー | FastAPI + uvicorn | Express |
| シグナル処理 | `signal.signal` | `process.on('SIGTERM')` |
| setup_hook | `async def setup_hook()` | `login()` 前の `main()` |
| エラーハンドリング | 各コマンドの `try-except` | `interactionCreate` 内の `try/catch` |
| customId | 該当なし（コールバック直接登録） | `'action:page:keyword'` 形式 |

### 12.2 Rustポーティングへのロードマップ

| TypeScript | Rust |
|---|---|
| `discord.js v14` | `serenity` / `twilight` |
| `Express` | `axum` / `actix-web` |
| `better-sqlite3` | `rusqlite` |
| Promise / 同期API | `tokio::task::spawn_blocking` |

---

## 13. 付録：完全ソースコード

### src/types.ts

```typescript
export interface VideoRow {
    title: string | null;
    super_title: string | null;
    video_url: string;
    view_count: string | null;
    channel_name: string | null;
    channel_url: string | null;
    publish_date: string | null;
    relative_date: string | null;
}
```

### src/database.ts

```typescript
import Database from 'better-sqlite3';
import { VideoRow } from './types';

const DB_PATH = process.env.DB_PATH || 'rakugo.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

export function initFts(): void {
    console.log(`📦 SQLite Version: ${db.prepare('SELECT sqlite_version()').pluck().get()}`);

    db.exec(`DROP TABLE IF EXISTS videos_fts`);
    db.exec(`
        CREATE VIRTUAL TABLE videos_fts USING fts5(
            title, super_title,
            content='videos', content_rowid='rowid',
            tokenize='trigram'
        )
    `);
    db.exec(`
        INSERT INTO videos_fts(rowid, title, super_title)
        SELECT rowid, title, super_title FROM videos
    `);
    db.exec(`INSERT INTO videos_fts(videos_fts) VALUES('optimize')`);
    console.log('✅ FTS5 index rebuilt and optimized.');
}

export function searchVideos(
    keyword: string,
    limit = 7,
    offset = 0
): { rows: VideoRow[], total: number } {
    const keywords = keyword.trim().replace(/　/g, ' ').split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return { rows: [], total: 0 };

    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const k of keywords) {
        const kClean = k.replace(/"/g, ' ').trim();
        if (!kClean) continue;

        if (kClean.length >= 3) {
            conditions.push('v.rowid IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH ?)');
            params.push(`"${kClean}"`);
        } else {
            conditions.push('(v.title LIKE ? OR v.super_title LIKE ?)');
            params.push(`%${kClean}%`, `%${kClean}%`);
        }
    }

    const whereClause = conditions.length ? conditions.join(' AND ') : '1=1';

    const total = db
        .prepare(`SELECT COUNT(*) FROM videos v WHERE ${whereClause}`)
        .pluck()
        .get(...params) as number;

    const rows = db.prepare(`
        SELECT title, super_title, video_url, view_count,
               channel_name, channel_url, publish_date, relative_date
        FROM videos v
        WHERE ${whereClause}
        ORDER BY
            CASE WHEN v.view_count IS NULL OR v.view_count = '' THEN 0
                 ELSE CAST(v.view_count AS INTEGER) END DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as VideoRow[];

    return { rows, total };
}

export function getVideoByUrl(url: string): VideoRow | undefined {
    return db.prepare('SELECT * FROM videos WHERE video_url = ?').get(url) as VideoRow | undefined;
}
```

### src/deploy.ts

```typescript
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

const commands = [
    new SlashCommandBuilder()
        .setName('rakugo')
        .setDescription('落語動画をキーワード検索します')
        .addStringOption(option =>
            option
                .setName('keyword')
                .setDescription('検索ワード（スペース区切りでAND検索）')
                .setRequired(true)
        ),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN!);

export async function deployCommands(): Promise<void> {
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID!),
            { body: commands },
        );
        console.log('✅ スラッシュコマンド同期完了');
    } catch (error) {
        console.error('コマンド同期エラー:', error);
    }
}
```

### src/index.ts

```typescript
import {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} from 'discord.js';
import * as dotenv from 'dotenv';
import express from 'express';
import { initFts, searchVideos, getVideoByUrl } from './database';
import { deployCommands } from './deploy';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ],
});

// ヘルスチェック用サーバー（Python版の FastAPI に相当）
const app = express();
app.get('/', (_req, res) => res.json({ status: 'running', bot: client.user?.tag ?? 'starting' }));
app.listen(7860, () => console.log('🌐 Health server on port 7860'));

// ─── ヘルパー：Embed の description を生成 ───
function buildDescription(
    rows: { title: string | null; super_title: string | null; video_url: string; channel_name: string | null; view_count: string | null }[],
    startIndex: number
): string {
    return rows.map((r, i) =>
        `${startIndex + i + 1}. [${r.title || r.super_title || 'Untitled'}](${r.video_url})\n` +
        `└ ${r.channel_name || '不明'} | ${r.view_count || 0} views`
    ).join('\n\n') || '該当なし';
}

// ─── ヘルパー：ボタン・セレクトメニューを生成 ───
function buildComponents(
    keyword: string,
    page: number,
    total: number,
    rows: { title: string | null; super_title: string | null; video_url: string; channel_name: string | null }[]
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
    const select = new StringSelectMenuBuilder()
        .setCustomId('select_video')
        .setPlaceholder('詳細を見る動画を選択...')
        .addOptions(rows.map((r, i) => ({
            label: `${page * 7 + i + 1}. ${r.title || r.super_title || 'Untitled'}`.slice(0, 100),
            value: r.video_url,
            description: (r.channel_name ?? '').slice(0, 100),
        })));

    const prevBtn = new ButtonBuilder()
        .setCustomId(`prev:${page}:${keyword}`)
        .setLabel('◀️ 前へ')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0);

    const nextBtn = new ButtonBuilder()
        .setCustomId(`next:${page}:${keyword}`)
        .setLabel('次へ ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * 7 >= total);

    return [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn),
    ];
}

// ─── イベントハンドラ ───
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user?.tag}`);
});

client.on('interactionCreate', async (interaction) => {

    // 1. スラッシュコマンド
    if (interaction.isChatInputCommand() && interaction.commandName === 'rakugo') {
        const ageMs = Date.now() - interaction.createdTimestamp;
        if (ageMs > 2_500) {
            console.warn(`Stale interaction skipped (${ageMs}ms old)`);
            return;
        }

        try {
            await interaction.deferReply();
        } catch {
            console.warn('Interaction expired before deferReply');
            return;
        }

        try {
            const keyword = interaction.options.getString('keyword', true);
            const { rows, total } = searchVideos(keyword, 7, 0);

            if (total === 0) {
                return void await interaction.editReply(`「${keyword}」に一致する落語は見つかりませんでした。`);
            }

            const embed = new EmbedBuilder()
                .setTitle(`🔍 「${keyword}」の検索結果`)
                .setColor(0xe85d3a)
                .setDescription(buildDescription(rows, 0))
                .setFooter({ text: `1 / ${Math.ceil(total / 7)} ページ（合計 ${total} 件）` });

            await interaction.editReply({
                embeds: [embed],
                components: buildComponents(keyword, 0, total, rows),
            });

        } catch (error) {
            console.error('Error in /rakugo:', error);
            try {
                await interaction.editReply('検索中にエラーが発生しました。もう一度試してください。');
            } catch { /* ignore */ }
        }
    }

    // 2. ページングボタン
    if (interaction.isButton()) {
        const [action, pageStr, ...keywordParts] = interaction.customId.split(':');
        const keyword = keywordParts.join(':');
        const currentPage = parseInt(pageStr, 10);

        if (action !== 'prev' && action !== 'next') return;

        await interaction.deferUpdate();

        const newPage = action === 'next' ? currentPage + 1 : currentPage - 1;
        const { rows, total } = searchVideos(keyword, 7, newPage * 7);

        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setDescription(buildDescription(rows, newPage * 7))
            .setFooter({ text: `${newPage + 1} / ${Math.ceil(total / 7)} ページ（合計 ${total} 件）` });

        await interaction.editReply({
            embeds: [embed],
            components: buildComponents(keyword, newPage, total, rows),
        });
    }

    // 3. セレクトメニュー（詳細表示）
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_video') {
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch {
            return;
        }

        const video = getVideoByUrl(interaction.values[0]);
        if (!video) {
            return void await interaction.followUp({ content: '詳細が見つかりませんでした。', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle(video.title || video.super_title || 'Untitled')
            .setURL(video.video_url)
            .setColor(0xff0000)
            .addFields(
                { name: 'チャンネル', value: video.channel_name || '不明', inline: true },
                { name: '再生数',     value: `${video.view_count || 0} 回`,    inline: true },
                { name: '公開日',     value: video.publish_date || video.relative_date || '不明', inline: true },
            );

        await interaction.followUp({ embeds: [embed], ephemeral: true });
    }
});

// ─── 起動シーケンス（Python版の setup_hook に相当） ───
async function main(): Promise<void> {
    initFts();
    await deployCommands();
    await client.login(process.env.BOT_TOKEN!);
}

main().catch(err => {
    console.error('Critical Error:', err);
    process.exit(1);
});
```

---

*次のステップ：Rust版チュートリアル（serenity + rusqlite + tokio）*
