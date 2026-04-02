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

// ─── Discord クライアント ───
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ],
});

// ─── ヘルスチェック用 Express サーバー（Python版の FastAPI に相当） ───
const app = express();
app.get('/', (_req, res) => res.json({ status: 'running', bot: client.user?.tag ?? 'starting' }));
app.listen(7860, () => console.log('🌐 Health server on port 7860'));

// ─────────────────────────────────────────────
// UIコンポーネントの構築
// Python版の create_embed() + ボタン定義に相当
// ─────────────────────────────────────────────
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
    // ※ customId のデリミタは ':' を使用。'_' はキーワードと衝突するため NG
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

// ─────────────────────────────────────────────
// Embed の本文を生成するヘルパー
// ─────────────────────────────────────────────
function buildDescription(
    rows: { title: string | null; super_title: string | null; video_url: string; channel_name: string | null; view_count: string | null }[],
    startIndex: number
): string {
    return rows.map((r, i) =>
        `${startIndex + i + 1}. [${r.title || r.super_title || 'Untitled'}](${r.video_url})\n` +
        `└ ${r.channel_name || '不明'} | ${r.view_count || 0} views`
    ).join('\n\n') || '該当なし';
}

// ─────────────────────────────────────────────
// イベントハンドラ
// ─────────────────────────────────────────────
client.once('ready', () => {
    // Python版の on_ready() に相当。ここはログのみ
    console.log(`✅ Logged in as ${client.user?.tag}`);
});

client.on('interactionCreate', async (interaction) => {

    // ── 1. スラッシュコマンド ──
    if (interaction.isChatInputCommand() && interaction.commandName === 'rakugo') {

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
    }

    // ── 2. ページングボタン ──
    if (interaction.isButton()) {
        // キーワード内の ':' を許容するため、残余引数で結合して復元する
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

    // ── 3. セレクトメニュー（詳細表示） ──
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

// ─────────────────────────────────────────────
// 起動シーケンス
// Python版の setup_hook() に相当。login() の前に全て完了させる
// ─────────────────────────────────────────────
async function main(): Promise<void> {
    initFts();                                    // FTS5テーブル構築
    await deployCommands();                       // スラッシュコマンド同期
    await client.login(process.env.BOT_TOKEN!);   // Bot ログイン
}

main().catch(err => {
    console.error('Critical Error:', err);
    process.exit(1);
});