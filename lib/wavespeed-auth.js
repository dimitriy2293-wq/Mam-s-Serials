import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import fetch from "node-fetch";

chromium.use(stealth());

// Храним данные текущей сессии в оперативной памяти + защита от двойных кликов
export const sessionStore = {
  address: null,
  password: null,
  token: null,
  username: null,
  isProcessingStep1: false, // Защита от спама команды /update_key
  isProcessingStep2: false  // Защита от спама команды /finish_key
};

// 1. Генерация временной почты
async function getMailTmAccount() {
  const domainRes = await fetch('https://api.mail.tm/domains');
  const domainData = await domainRes.json();
  const domain = domainData['hydra:member'][0].domain;

  const login = `botuser${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const address = `${login}@${domain}`;
  const password = `Pass!${Date.now()}#99`;

  await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password })
  });

  const tokenRes = await fetch('https://api.mail.tm/token', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ address, password })
  });
  const tokenData = await tokenRes.json();
  
  return { address, token: tokenData.token, password };
}

// Универсальный перехватчик кода (с удалением письма, чтобы не было путаницы)
async function getCodeFromMail(token) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`https://api.mail.tm/messages`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      
      if (data['hydra:member'] && data['hydra:member'].length > 0) {
        const msgId = data['hydra:member'][0].id;
        const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const msgData = await msgRes.json();
        
        const match = msgData.text.match(/\b\d{6,8}\b/);
        if (match) {
           // Удаляем письмо, чтобы следующий запрос кода его не прочитал
           await fetch(`https://api.mail.tm/messages/${msgId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
           return match[0];
        }
      }
    } catch (e) {}
  }
  throw new Error("Код не пришел вовремя.");
}

// ==========================================
// ФУНКЦИЯ 1: Пользователь просит данные
// ==========================================
export async function step1_start(bot, chatId) {
  // Защита от двойного клика (лага)
  if (sessionStore.isProcessingStep1) {
    return bot.api.sendMessage(chatId, "⏳ Я уже генерирую для тебя данные. Подожди секунду...");
  }
  
  sessionStore.isProcessingStep1 = true;

  try {
    await bot.api.sendMessage(chatId, "⏳ Генерирую почту и данные...");
    
    const acc = await getMailTmAccount();
    sessionStore.address = acc.address;
    sessionStore.password = acc.password;
    sessionStore.token = acc.token;
    sessionStore.username = `botuser${Math.floor(Math.random() * 89999 + 10000)}`;

    await bot.api.sendMessage(chatId, 
      `🔥 <b>Регистрация без лагов!</b>\n\n` +
      `1. Открой с телефона/ПК ссылку: https://github.com/signup\n` +
      `2. Скопируй и вставь эти данные:\n\n` +
      `📧 Почта: <code>${sessionStore.address}</code>\n` +
      `🔑 Пароль: <code>${sessionStore.password}</code>\n` +
      `👤 Юзер: <code>${sessionStore.username}</code>\n\n` +
      `3. Пройди капчу и нажми Create account.\n\n` +
      `⏳ <i>Я жду письмо от GitHub. Ничего не нажимай...</i>`,
      { parse_mode: "HTML" }
    );

    const code = await getCodeFromMail(sessionStore.token);
    await bot.api.sendMessage(chatId, 
      `✅ <b>Лови код от GitHub!</b>\n\n👉 <code>${code}</code>\n\n` +
      `Введи его на сайте. Как только тебя пустит в аккаунт, напиши мне команду /finish_key`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await bot.api.sendMessage(chatId, "⚠️ Письмо с кодом не пришло или произошла ошибка. Попробуй начать заново (/update_key).");
  } finally {
    sessionStore.isProcessingStep1 = false;
  }
}

// ==========================================
// ФУНКЦИЯ 2: Скрытый логин и захват ключа
// ==========================================
export async function step2_finish(bot, chatId) {
  if (sessionStore.isProcessingStep2) {
    return bot.api.sendMessage(chatId, "⏳ Уже настраиваю твой аккаунт, подожди...");
  }
  if (!sessionStore.address) {
    return bot.api.sendMessage(chatId, "❌ Нет активной сессии. Начни сначала (/update_key).");
  }

  sessionStore.isProcessingStep2 = true;
  await bot.api.sendMessage(chatId, "🚀 Запускаю скрытый режим. Захожу в твой новый GitHub...");
  let browser;

  try {
    browser = await chromium.launch({
      headless: true, // ПОЛНОСТЬЮ СКРЫТЫЙ РЕЖИМ
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. Логин в GitHub
    await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" });
    await page.type('#login_field', sessionStore.address);
    await page.type('#password', sessionStore.password);
    await page.click('input[name="commit"]');
    
    await page.waitForTimeout(3000);

    // 2. Проверка: не просит ли GitHub код подтверждения устройства
    if (page.url().includes('sessions/verified-device') || await page.$('#otp')) {
      await bot.api.sendMessage(chatId, "🔐 GitHub заметил новый IP сервера. Запрашиваю код устройства с почты...");
      const deviceCode = await getCodeFromMail(sessionStore.token);
      await page.type('#otp', deviceCode);
      await page.waitForNavigation({ waitUntil: "domcontentloaded" });
    }

    await bot.api.sendMessage(chatId, "✅ В GitHub зашел! Авторизую WaveSpeed...");

    // 3. Логин в WaveSpeed
    await page.goto("https://wavespeed.ai/login", { waitUntil: "domcontentloaded" });
    
    // Умный поиск нужной кнопки: ищем кнопки/ссылки с текстом GitHub, 
    // но ПРОПУСКАЕМ их социальную ссылку на профиль (из-за которой была ошибка)
    const gitHubElements = page.locator('button, a').filter({ hasText: /GitHub/i });
    const count = await gitHubElements.count();
    let clicked = false;
    
    for (let i = 0; i < count; i++) {
      const el = gitHubElements.nth(i);
      const href = await el.getAttribute('href');
      
      // Исключаем ссылку на их GitHub-репозиторий
      if (!href || !href.includes('github.com/WaveSpeedAI')) {
        if (await el.isVisible()) {
          await el.click();
          clicked = true;
          break;
        }
      }
    }
    
    if (!clicked) {
      throw new Error("Не нашел правильную кнопку авторизации на сайте WaveSpeed.");
    }

    try {
      await page.waitForSelector('button[name="authorize"]', { timeout: 10000 });
      await page.click('button[name="authorize"]');
    } catch (e) {}

    // 4. Забираем ключ
    await page.goto("https://wavespeed.ai/accesskey", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[readonly]');
    const newApiKey = await page.inputValue('input[readonly]');

    // 5. Обновляем Render
    const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
    if (RENDER_API_KEY && RENDER_SERVICE_ID) {
      await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
        method: "PUT",
        headers: { "Accept": "application/json", "Content-Type": "application/json", "Authorization": `Bearer ${RENDER_API_KEY}` },
        body: JSON.stringify([{ envVarName: "WAVESPEED_API_KEY", envVarValue: newApiKey }])
      });
    }

    await bot.api.sendMessage(chatId, `🎉 <b>УСПЕХ!</b> Твой новый API ключ сохранен.\n\n<code>${newApiKey}</code>`, { parse_mode: "HTML" });

  } catch (err) {
    console.error(err);
    await bot.api.sendMessage(chatId, "❌ Ошибка при получении ключа: " + err.message);
  } finally {
    if (browser) await browser.close();
    sessionStore.isProcessingStep2 = false;
  }
}
