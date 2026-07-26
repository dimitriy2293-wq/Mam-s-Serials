# Используем официальный образ с зависимостями для браузеров
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Устанавливаем ffmpeg (он нужен для склейки видео)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production

# Устанавливаем сам браузер Chromium
RUN npx playwright install chromium

COPY . .

EXPOSE 3000
CMD ["node", "bot.js"]
