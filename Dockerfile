FROM node:18-slim

# Устанавливаем ffmpeg и базовые утилиты
RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# Устанавливаем пакеты
RUN npm install

# Устанавливаем ТОЛЬКО Chromium и его системные зависимости (чтобы не качать лишнее)
RUN npx playwright install chromium --with-deps

COPY . .

EXPOSE 3000
CMD ["node", "bot.js"]
