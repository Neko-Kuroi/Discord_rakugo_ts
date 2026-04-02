import Database from 'better-sqlite3';
import { VideoRow } from './types';

const DB_PATH = process.env.DB_PATH || 'rakugo.db';
const db = new Database(DB_PATH);

// WALモードで書き込みパフォーマンスを向上
db.pragma('journal_mode = WAL');

/**
 * FTS5仮想テーブルとインデックスを作成する。
 * Python版の create_fts_and_indexes() に相当。
 * 起動時に毎回再構築してインデックスの整合性を保証する。
 */
export function initFts(): void {
    console.log(`📦 SQLite Version: ${db.prepare('SELECT sqlite_version()').pluck().get()}`);

    // DDL は autocommit のため transaction は不要
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

/**
 * キーワード検索。3文字以上は FTS5、2文字以下は LIKE にフォールバック。
 */
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

    // 総件数の取得
    const total = db
        .prepare(`SELECT COUNT(*) FROM videos v WHERE ${whereClause}`)
        .pluck()
        .get(...params) as number;

    // データの取得（view_count の降順）
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

/**
 * URLから1件取得（セレクトメニューの詳細表示用）
 */
export function getVideoByUrl(url: string): VideoRow | undefined {
    return db.prepare('SELECT * FROM videos WHERE video_url = ?').get(url) as VideoRow | undefined;
}