FROM node:22-slim

# Instala ferramentas necessárias para dependências de áudio do Discord.js
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Configura diretório de trabalho
WORKDIR /app

# Copia e instala dependências Node.js
COPY package.json ./
RUN npm install

# Copia e roda a aplicação
COPY index.js ./
CMD ["npm", "start"]
