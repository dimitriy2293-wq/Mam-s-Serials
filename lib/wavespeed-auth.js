import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

chromium.use(stealth());

// 1. Генерация временной почты через Mail.tm
async function getMailTmAccount() {
  const domainRes = await fetch('https://api.mail.tm/domains');
  if (!domainRes.ok) throw new Error(`Ошибка API Mail.tm (домены): ${domainRes.status}`);
  const domainData = await domainRes.json();
  const domain = domainData['hydra:member'][0].domain;

  const login = `botuser${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const address = `${login}@${domain}`;
  const password = `Pass!${Date.now()}#99`;

  const createRes = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password })
  });
  if (!createRes.ok) throw new Error(`Ошибка API Mail.tm (создание): ${createRes.status}`);

  const tokenRes = await fetch('https://api.mail.tm/token', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ address, password })
  });
  if (!tokenRes.ok) throw new Error(`Ошибка API Mail.tm (токен): ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  
  return { address, token: tokenData.token };
}

// 2. Чтение кода подтверждения от GitHub через токен Mail.tm
async function getGitHubCode(token) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`https://api.mail.tm/messages`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      
      if (data['hydra:member'] && data['hydra:member'].length > 0) {
        const msgId = data['hydra:member'][0].id;
        const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const msgData = await msgRes.json();
        const match = msgData.text.match(/\b\d{6,8}\b/);
        if (match) return match[0];
      }
    } catch (e) {
      console.log("Ожидание письма...");
    }
  }
  throw new Error("Код подтверждения от GitHub не пришел.");
}

// 3. Обновление переменной окружения на хостинге Render
async function updateRenderEnv(newKey) {
  const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.log("RENDER_API_KEY / RENDER_SERVICE_ID не заданы. Ключ обновлен в памяти.");
    return;
  }

  await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
    method: "PUT",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RENDER_API_KEY}`
    },
    body: JSON.stringify([{ envVarName: "WAVESPEED_API_KEY", envVarValue: newKey }])
  });
  console.log("Ключ успешно обновлен в Render!");
}

// 4. Главная функция авторегистрации
export async function generateAndApplyNewKey(bot, chatId) {
  console.log("Запуск оптимизированной авторегистрации...");
  let browser;

  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const acc = await getMailTmAccount();
    const password = `Pass!${Date.now()}#99`;
    const ghUsername = `botuser${Math.floor(Math.random() * 899999 + 100000)}`;

    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US'
    });

    // Оптимизация: блокируем картинки и шрифты, чтобы GitHub летал даже на слабом сервере
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const vncUrl = `${process.env.RENDER_EXTERNAL_URL}/vnc/vnc.html?autoconnect=true&resize=scale&quality=2&compression=9&path=websockify`;
    await bot.api.sendMessage(chatId, `🚨 <b>Начинаю регистрацию (турбо-режим)!</b>\n\nОткрой VNC:\n👉 ${vncUrl}\n\n<b>Данные:</b>\nПочта: <code>${acc.address}</code>\nПароль: <code>${password}</code>\nЮзернейм: <code>${ghUsername}</code>`, { parse_mode: "HTML" });

    // Увеличили тайм-аут до 120 секунд (2 минуты) на случай лагов хостинга
    await page.goto("https://github.com/signup", { waitUntil: "domcontentloaded", timeout: 120000 });

    try {
      console.log("Ожидаем появления формы...");
      await page.waitForSelector('#email', { state: 'visible', timeout: 30000 });
      await page.waitForTimeout(1000);
      
      console.log("Заполняем данные...");
      await page.type('#email', acc.address, { delay: 100 });
      await page.type('#password', password, { delay: 100 });
      await page.type('#login', ghUsername, { delay: 100 });

      const optInCheckbox = await page.$('#opt_in');
      if (optInCheckbox) {
        await page.uncheck('#opt_in').catch(() => {});
      }

      await bot.api.sendMessage(chatId, 
        `⏳ <b>Форма заполнена!</b>\n\n` +
        `Зайди в VNC, нажми зеленую кнопку <b>Create account</b> и пройди капчу.`, 
        { parse_mode: "HTML" }
      );

    } catch (fillError) {
      console.log("Автозаполнение не прошло:", fillError.message);
      await bot.api.sendMessage(chatId, "⚠️ Заполни форму в VNC вручную по данным выше и пройди капчу.", { parse_mode: "HTML" });
    }

    console.log("Ждем ручного прохождения капчи...");
    await page.waitForSelector('input[name="code"], #code', { state: 'visible', timeout: 180000 });
    await bot.api.sendMessage(chatId, "✅ Вижу поле для кода! Перехватываю письмо...");

    const code = await getGitHubCode(acc.token);
    await page.type('input[name="code"], #code', code, { delay: 100 });

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

    await bot.api.sendMessage(chatId, "🚀 Аккаунт создан! Получаю ключ WaveSpeed...");
    await page.goto("https://wavespeed.ai/login", { waitUntil: "domcontentloaded" });
    
    await page.click('button:has-text("GitHub"), a:has-text("GitHub")');

    try {
      await page.waitForSelector('button[name="authorize"]', { timeout: 10000 });
      await page.click('button[name="authorize"]');
    } catch (e) {}

    await page.goto("https://wavespeed.ai/accesskey", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[readonly]');
    const newApiKey = await page.inputValue('input[readonly]');

    process.env.WAVESPEED_API_KEY = newApiKey;
    await updateRenderEnv(newApiKey);

    return newApiKey;
  } catch (err) {
    console.error("Критическая ошибка:", err.message);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
