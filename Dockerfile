FROM node:18-slim

# Установка системных зависимостей для ffmpeg и Playwright
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

# Установка браузера Playwright внутри контейнера
RUN npx playwright install --with-deps

COPY . .

EXPOSE 3000

CMD ["node", "bot.js"]
