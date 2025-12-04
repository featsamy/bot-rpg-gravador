import discord
import os
import requests
from discord.ext import commands

# Pega as senhas do ambiente (configuradas no Portainer)
TOKEN = os.getenv("DISCORD_TOKEN")
N8N_WEBHOOK_URL = os.getenv("N8N_WEBHOOK_URL") 

intents = discord.Intents.default()
intents.message_content = True # Permite ler mensagens

bot = commands.Bot(command_prefix="!", intents=intents)

# Memória temporária de quem está gravando
connections = {}

@bot.event
async def on_ready():
    print(f"✅ Bot online como: {bot.user}")

@bot.command()
async def gravar(ctx):
    voice = ctx.author.voice
    if not voice:
        return await ctx.send("❌ Entre em um canal de voz primeiro!")

    # Conecta e começa a gravar
    vc = await voice.channel.connect()
    connections.update({ctx.guild.id: vc})
    
    # Inicia gravação em MP3
    vc.start_recording(
        discord.sinks.MP3Sink(),
        finished_callback,
        ctx.channel,
    )
    await ctx.send(f"🔴 **Gravando!** Estou ouvindo o canal `{voice.channel.name}`.")

@bot.command()
async def parar(ctx):
    if ctx.guild.id in connections:
        vc = connections[ctx.guild.id]
        vc.stop_recording() # Isso dispara o envio
        del connections[ctx.guild.id]
        await ctx.delete() # Bot sai da sala
        await ctx.send("🛑 Parei! Enviando áudio para o Mestre (IA)...")
    else:
        await ctx.send("Eu não estou gravando nada.")

async def finished_callback(sink, channel: discord.TextChannel, *args):
    # Essa função roda quando a gravação para
    recorded_users = [f"<@{user_id}>" for user_id, audio in sink.audio_data.items()]
    await channel.send(f"🎙️ Processando áudio de: {', '.join(recorded_users)}.")

    for user_id, audio in sink.audio_data.items():
        # Prepara o arquivo para enviar ao n8n
        files = {
            'file': (f'audio_{user_id}.mp3', audio.file, 'audio/mpeg')
        }
        # Envia o ID do usuário junto
        data = {'user_id': user_id}

        try:
            requests.post(N8N_WEBHOOK_URL, files=files, data=data)
        except Exception as e:
            await channel.send(f"⚠️ Erro ao enviar para o n8n: {e}")

    await channel.send("✅ Áudio enviado para a IA!")

bot.run(TOKEN)
