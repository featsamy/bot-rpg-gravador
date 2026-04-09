import { Client, GatewayIntentBits } from 'discord.js';
import { 
    joinVoiceChannel, 
    EndBehaviorType,
    createAudioPlayer,
    createAudioResource,
    StreamType
} from '@discordjs/voice';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';
import prism from 'prism-media';
import { Readable } from 'stream';
import { spawn } from 'child_process';

class Silence extends Readable {
    constructor() {
        super();
        this.sent = false;
    }
    _read() {
        if (!this.sent) {
            this.push(Buffer.alloc(1920, 0));
            this.sent = true;
        } else {
            this.push(null);
        }
    }
}

dotenv.config();

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ] 
});

const s3Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY,
        secretAccessKey: process.env.R2_SECRET_KEY,
    }
});

const recordingSessions = new Map();

client.on('ready', () => {
    console.log(`✅ Bot SaaS Online (Node.js): ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!gravar') {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply("❌ Entre em um canal de voz primeiro!");
        }

        const guildId = message.guild.id;
        if (recordingSessions.has(guildId)) {
            return message.reply("Já estou gravando!");
        }

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false,
            });

            // Play silence to establish RTP connection to receive audio
            const player = createAudioPlayer();
            player.on('error', error => console.error('Error on AudioPlayer:', error.message));
            connection.subscribe(player);
            player.play(createAudioResource(new Silence(), { inputType: StreamType.Raw }));

            recordingSessions.set(guildId, {
                connection,
                streams: new Map(),
                channelName: voiceChannel.name,
                users: new Set()
            });

            connection.receiver.speaking.on('start', (userId) => {
                const session = recordingSessions.get(guildId);
                if (!session) return;
                
                session.users.add(userId);

                if (!session.streams.has(userId)) {
                    const opusStream = connection.receiver.subscribe(userId, {
                        end: { behavior: EndBehaviorType.Manual },
                    });

                    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
                    const filename = `sessao_${guildId}_${userId}.ogg`;

                    const ffmpegProcess = spawn('ffmpeg', [
                        '-f', 's16le', '-ar', '48000', '-ac', '2',
                        '-i', 'pipe:0',
                        '-acodec', 'libopus',
                        '-f', 'opus', 
                        '-y', filename
                    ]);
                    
                    ffmpegProcess.on('error', err => console.error('FFmpeg Error:', err));
                    opusStream.on('error', err => console.error('OpusStream Error:', err));

                    opusStream.pipe(decoder).pipe(ffmpegProcess.stdin);
                    session.streams.set(userId, { opus: opusStream, ffmpeg: ffmpegProcess });
                }
            });

            await message.channel.send(`🔴 **Gravando Sessão!** (Modo Cloud via Node.js V2E) em \`${voiceChannel.name}\`.`);
        } catch (error) {
            console.error(error);
            message.reply("Ocorreu um erro ao conectar.");
        }
    }

    if (message.content === '!parar') {
        const guildId = message.guild.id;
        const session = recordingSessions.get(guildId);

        if (!session) {
            return message.reply("Não estou gravando nada.");
        }

        await message.channel.send("☁️ Finalizando e iniciando Upload para o Cloudflare R2...");

        const connection = session.connection;
        
        // Finaliza streams primeiro
        for (const [userId, record] of session.streams.entries()) {
            record.opus.unpipe();
            record.ffmpeg.stdin.end();
        }

        connection.destroy();
        recordingSessions.delete(guildId);

        // Dá um tempinho pequeno para os arquivos finalizarem a escrita em disco com segurança
        setTimeout(async () => {
            try {
                const uploadedUrls = [];
                
                for (const userId of session.users) {
                    const filename = `sessao_${guildId}_${userId}.ogg`;
                    
                    if (fs.existsSync(filename)) {
                        const fileStream = fs.createReadStream(filename);
                        const cloudName = `jogadores/${filename}`;

                        await s3Client.send(new PutObjectCommand({
                            Bucket: process.env.R2_BUCKET_NAME,
                            Key: cloudName,
                            Body: fileStream,
                            ContentType: "audio/ogg",
                        }));

                        const publicUrl = `${process.env.R2_PUBLIC_URL}/${cloudName}`;
                        uploadedUrls.push({
                            user_id: userId,
                            url: publicUrl
                        });

                        fs.unlinkSync(filename);
                    }
                }

                if (uploadedUrls.length > 0) {
                    const payload = {
                        guild_id: guildId,
                        jogadores: uploadedUrls
                    };

                    await axios.post(process.env.N8N_WEBHOOK_URL, payload);
                    await message.channel.send(`✅ Sessão salva no R2 e acionou o Workflow do n8n com sucesso! (${uploadedUrls.length} faixas exportadas)`);
                } else {
                    await message.channel.send(`Ninguém falou durante a gravação!`);
                }

            } catch (error) {
                console.error('Erro no upload ou webhook:', error);
                await message.channel.send("❌ Ocorreu um erro ao salvar o áudio na nuvem.");
            }
        }, 1500); 
    }

    if (message.content === '!sair') {
        const guildId = message.guild.id;
        const session = recordingSessions.get(guildId);
        if (session) {
            session.connection.destroy();
            recordingSessions.delete(guildId);
        } else {
            const vc = message.member.voice.channel;
            if (vc) {
                const conn = joinVoiceChannel({
                    channelId: vc.id,
                    guildId: guildId,
                    adapterCreator: vc.guild.voiceAdapterCreator,
                });
                setTimeout(() => conn.destroy(), 100);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
