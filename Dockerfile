FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Говорим системе не задавать вопросов при установке пакетов
ENV DEBIAN_FRONTEND=noninteractive

# Xvfb/x11vnc/novnc/websockify раньше стояли тут "на всякий случай", но
# Playwright запускается с headless: true (см. lib/wavespeed-auth.js) — им
# реально ничего не пользуется. Эти процессы висели в контейнере круглосуточно,
# отъедая память и CPU, которые нужны ffmpeg во время монтажа short'ов, и были
# главным подозреваемым в зависаниях сборки. Оставляем только ffmpeg.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production

# ДОБАВЛЕНО: Принудительно ставим плагины для обхода блокировок
RUN npm install playwright-extra puppeteer-extra-plugin-stealth node-fetch

# Устанавливаем сам браузер
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

CMD ["node", "bot.js"]
