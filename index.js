import { Client, GatewayIntentBits } from 'discord.js';
import { 
    joinVoiceChannel, 
    EndBehaviorType
} from '@discordjs/voice';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';
import prism from 'prism-media';

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
                        end: {
                            behavior: EndBehaviorType.Manual,
                        },
                    });

                    const oggStream = new prism.opus.OggLogicalBitstream({
                        opusHead: new prism.opus.OpusHead({
                            channelCount: 2,
                            sampleRate: 48000,
                        }),
                        pageSizeControl: {
                            maxPackets: 10,
                        },
                    });

                    const filename = `sessao_${guildId}_${userId}.ogg`;
                    const outStream = fs.createWriteStream(filename);

                    opusStream.pipe(oggStream).pipe(outStream);
                    session.streams.set(userId, outStream);
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
        for (const [userId, stream] of session.streams.entries()) {
            stream.end();
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
            const ghostConnection = message.guild.members.me.voice;
            if (ghostConnection) {
                ghostConnection.disconnect();
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
