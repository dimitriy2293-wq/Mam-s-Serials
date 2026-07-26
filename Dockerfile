FROM node:22-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "bot.js"]

FROM node:18-slim

# Установка системных зависимостей для Playwright, если требуется
RUN apt-get update && apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2

WORKDIR /app

COPY package*.json ./
RUN npm install

# Устанавливаем браузер для Playwright прямо во время сборки контейнера
RUN npx playwright install --with-deps

COPY . .

CMD ["npm", "start"]
