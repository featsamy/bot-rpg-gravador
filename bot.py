import discord
import os
import requests
from discord.ext import commands

TOKEN = os.getenv("DISCORD_TOKEN")
N8N_WEBHOOK_URL = os.getenv("N8N_WEBHOOK_URL") 

intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)

@bot.event
async def on_ready():
    print(f"✅ Bot online e atualizado: {bot.user}")

@bot.command()
async def gravar(ctx):
    voice = ctx.author.voice
    if not voice:
        return await ctx.send("❌ Entre em um canal de voz primeiro!")

    # Lógica de conexão blindada
    if ctx.voice_client:
        if ctx.voice_client.channel != voice.channel:
            await ctx.voice_client.move_to(voice.channel)
        vc = ctx.voice_client
    else:
        try:
            vc = await voice.channel.connect()
        except Exception as e:
            # Se der erro, tenta desconectar e conectar de novo (Reset forçado)
            print(f"Erro ao conectar: {e}. Tentando reset...")
            if ctx.guild.voice_client:
                await ctx.guild.voice_client.disconnect(force=True)
            vc = await voice.channel.connect()

    # Só começa a gravar se não estiver gravando
    if not vc.recording:
        vc.start_recording(
            discord.sinks.MP3Sink(),
            finished_callback,
            ctx.channel,
        )
        await ctx.send(f"🔴 **Gravando!** (Versão Atualizada) no canal `{voice.channel.name}`.")
    else:
        await ctx.send("Já estou gravando!")

@bot.command()
async def parar(ctx):
    vc = ctx.voice_client
    if vc and vc.recording:
        vc.stop_recording()
        await ctx.send("🛑 Parei! Processando áudio...")
        # Não desconectamos automaticamente para evitar o bug de reconexão
        # Se quiser sair, use !sair
    else:
        await ctx.send("Eu não estou gravando nada.")

@bot.command()
async def sair(ctx):
    if ctx.voice_client:
        await ctx.voice_client.disconnect()
        await ctx.send("👋 Saindo do canal.")

async def finished_callback(sink, channel: discord.TextChannel, *args):
    recorded_users = [f"<@{user_id}>" for user_id, audio in sink.audio_data.items()]
    await channel.send(f"🎙️ Enviando áudio de: {', '.join(recorded_users)}.")

    for user_id, audio in sink.audio_data.items():
        files = {
            'file': (f'audio_{user_id}.mp3', audio.file, 'audio/mpeg')
        }
        data = {'user_id': user_id}
        try:
            requests.post(N8N_WEBHOOK_URL, files=files, data=data)
        except Exception as e:
            print(f"Erro webhook: {e}")

bot.run(TOKEN)
