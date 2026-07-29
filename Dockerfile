FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Говорим системе не задавать вопросов при установке пакетов
ENV DEBIAN_FRONTEND=noninteractive

# Устанавливаем нужные пакеты
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    xvfb \
    x11vnc \
    novnc \
    websockify \
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

CMD ["sh", "-c", "Xvfb :99 -screen 0 1024x768x16 & x11vnc -forever -shared -rfbport 5900 -display :99 & websockify --web /usr/share/novnc/ 6080 localhost:5900 & DISPLAY=:99 node bot.js"]
