import discord
import os
import requests
import boto3
from discord.ext import commands

# CONFIGURAÇÕES
TOKEN = os.getenv("DISCORD_TOKEN")
N8N_WEBHOOK_URL = os.getenv("N8N_WEBHOOK_URL")

# Configurações do Cloudflare R2
R2_ENDPOINT = os.getenv("R2_ENDPOINT")
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY")
R2_SECRET_KEY = os.getenv("R2_SECRET_KEY")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME")
R2_PUBLIC_URL = os.getenv("R2_PUBLIC_URL")

intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)

# Conexão com o Cloudflare R2
s3_client = boto3.client(
    's3',
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY,
    aws_secret_access_key=R2_SECRET_KEY
)

@bot.event
async def on_ready():
    print(f"✅ Bot SaaS Online: {bot.user}")

@bot.command()
async def gravar(ctx):
    voice = ctx.author.voice
    if not voice:
        return await ctx.send("❌ Entre em um canal de voz primeiro!")

    # Limpa conexões zumbis
    if ctx.voice_client:
        try:
            await ctx.voice_client.disconnect(force=True)
            import asyncio
            await asyncio.sleep(1)
        except:
            pass

    try:
        # Conecta e aguarda estabilizar
        vc = await voice.channel.connect(timeout=20.0, reconnect=True)
        
        # O pulo do gato: pequeno delay para garantir que o estado 'connected' suba
        import asyncio
        await asyncio.sleep(1) 

        if not vc.recording:
            vc.start_recording(
                discord.sinks.MP3Sink(),
                finished_callback,
                ctx.channel,
            )
            await ctx.send(f"🔴 **Gravando Sessão!** em `{voice.channel.name}`.")
    except Exception as e:
        await ctx.send(f"❌ Erro ao iniciar: {e}")

@bot.command()
async def parar(ctx):
    vc = ctx.voice_client
    # Verifica se ele existe e se o estado de gravação está ativo
    if vc and vc.recording:
        try:
            vc.stop_recording()
            await ctx.send("🛑 Gravando finalizada! Subindo arquivos...")
        except Exception as e:
            await ctx.send(f"⚠️ Erro ao parar: {e}")
            await vc.disconnect(force=True)
    else:
        await ctx.send("Não estou gravando nada.")
        # Se ele está na call mas não gravando, force a saída para limpar o estado
        if vc:
            await vc.disconnect(force=True)

@bot.command()
async def sair(ctx):
    if ctx.voice_client:
        await ctx.voice_client.disconnect()

async def finished_callback(sink, channel: discord.TextChannel, *args):
    await channel.send("☁️ Uploading para o servidor seguro...")

    for user_id, audio in sink.audio_data.items():
        file_name = f"sessao_{channel.guild.id}_{user_id}.mp3"

        try:
            # 1. Faz Upload para o Cloudflare R2
            audio.file.seek(0)
            s3_client.upload_fileobj(audio.file, R2_BUCKET_NAME, file_name)

            # 2. Gera o Link Público
            file_url = f"{R2_PUBLIC_URL}/{file_name}"

            # 3. Envia SÓ O LINK para o n8n (JSON leve)
            payload = {
                'user_id': str(user_id),
                'audio_url': file_url,
                'server_name': str(channel.guild.name)
            }

            requests.post(N8N_WEBHOOK_URL, json=payload)
            print(f"Link enviado para n8n: {file_url}")

        except Exception as e:
            print(f"Erro no upload: {e}")
            await channel.send(f"⚠️ Erro ao processar áudio de <@{user_id}>.")

    await channel.send("✅ Sessão segura na nuvem e enviada para a IA!")

bot.run(TOKEN)
