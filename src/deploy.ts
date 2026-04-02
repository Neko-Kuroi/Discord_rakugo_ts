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

/**
 * スラッシュコマンドを Discord に登録する。
 * Python版の tree.sync() に相当。login() の前に実行する。
 */
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