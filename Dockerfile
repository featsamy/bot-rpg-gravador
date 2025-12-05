FROM python:3.11-slim

# Instala FFmpeg, dependências de compilação E O GIT
RUN apt-get update && \
    apt-get install -y ffmpeg libffi-dev libnacl-dev python3-dev build-essential git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala as bibliotecas do Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Inicia o bot
CMD ["python", "bot.py"]
