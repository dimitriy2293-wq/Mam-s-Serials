import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

chromium.use(stealth());[cite: 1]

// 1. Надежная генерация временной почты через Mail.tm[cite: 1]
async function getMailTmAccount() {
  // Получаем доступный домен[cite: 1]
  const domainRes = await fetch('https://api.mail.tm/domains');[cite: 1]
  if (!domainRes.ok) throw new Error(`Ошибка API Mail.tm (домены): ${domainRes.status}`);[cite: 1]
  const domainData = await domainRes.json();[cite: 1]
  const domain = domainData['hydra:member'][0].domain;[cite: 1]

  // Генерируем данные аккаунта[cite: 1]
  const login = `botuser${Date.now()}${Math.floor(Math.random() * 1000)}`;[cite: 1]
  const address = `${login}@${domain}`;[cite: 1]
  const password = `Pass!${Date.now()}#99`;[cite: 1]

  // Создаем аккаунт[cite: 1]
  const createRes = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',[cite: 1]
    headers: { 'Content-Type': 'application/json' },[cite: 1]
    body: JSON.stringify({ address, password })[cite: 1]
  });[cite: 1]
  if (!createRes.ok) throw new Error(`Ошибка API Mail.tm (создание): ${createRes.status}`);[cite: 1]

  // Получаем токен для чтения писем[cite: 1]
  const tokenRes = await fetch('https://api.mail.tm/token', {
     method: 'POST',[cite: 1]
     headers: { 'Content-Type': 'application/json' },[cite: 1]
     body: JSON.stringify({ address, password })[cite: 1]
  });[cite: 1]
  if (!tokenRes.ok) throw new Error(`Ошибка API Mail.tm (токен): ${tokenRes.status}`);[cite: 1]
  const tokenData = await tokenRes.json();[cite: 1]
  
  return { address, token: tokenData.token };[cite: 1]
}

// 2. Чтение кода подтверждения от GitHub через токен Mail.tm[cite: 1]
async function getGitHubCode(token) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 4000)); // Ждем 4 секунды между запросами[cite: 1]
    
    try {
      const res = await fetch(`https://api.mail.tm/messages`, {
        headers: { 'Authorization': `Bearer ${token}` }[cite: 1]
      });[cite: 1]
      const data = await res.json();[cite: 1]
      
      if (data['hydra:member'] && data['hydra:member'].length > 0) {
        const msgId = data['hydra:member'][0].id;[cite: 1]
        
        // Получаем само тело письма[cite: 1]
        const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, {
          headers: { 'Authorization': `Bearer ${token}` }[cite: 1]
        });[cite: 1]
        const msgData = await msgRes.json();[cite: 1]
        
        // Ищем 6-8 значный код от GitHub[cite: 1]
        const match = msgData.text.match(/\b\d{6,8}\b/);[cite: 1]
        if (match) return match[0];[cite: 1]
      }
    } catch (e) {
      console.log("Ожидание письма...");[cite: 1]
    }
  }
  throw new Error("Код подтверждения от GitHub не пришел.");[cite: 1]
}

// 3. Обновление переменной окружения на хостинге Render[cite: 1]
async function updateRenderEnv(newKey) {
  const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;[cite: 1]
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.log("RENDER_API_KEY / RENDER_SERVICE_ID не заданы. Ключ обновлен в памяти.");[cite: 1]
    return;[cite: 1]
  }

  await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
    method: "PUT",[cite: 1]
    headers: {
      "Accept": "application/json",[cite: 1]
      "Content-Type": "application/json",[cite: 1]
      "Authorization": `Bearer ${RENDER_API_KEY}`[cite: 1]
    },
    body: JSON.stringify([{ envVarName: "WAVESPEED_API_KEY", envVarValue: newKey }])[cite: 1]
  });[cite: 1]
  console.log("Ключ успешно обновлен в Render!");[cite: 1]
}

// 4. Главная функция авторегистрации[cite: 1]
export async function generateAndApplyNewKey(bot, chatId) {
  console.log("Запуск авторегистрации через GitHub + noVNC (через Mail.tm)...");[cite: 1]
  let browser;[cite: 1]

  try {
    // Запуск браузера без конфликтного --single-process[cite: 1]
    browser = await chromium.launch({
      headless: false,[cite: 1]
      args: [
        '--no-sandbox',[cite: 1]
        '--disable-setuid-sandbox',[cite: 1]
        '--disable-dev-shm-usage',[cite: 1]
        '--disable-gpu',[cite: 1]
        '--no-zygote',[cite: 1]
        '--disable-blink-features=AutomationControlled'[cite: 1]
      ]
    });[cite: 1]

    const acc = await getMailTmAccount();[cite: 1]
    const password = `Pass!${Date.now()}#99`;[cite: 1]
    const ghUsername = `botuser${Math.floor(Math.random() * 899999 + 100000)}`;[cite: 1]

    // Маскировка под обычный Windows Chrome[cite: 1]
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },[cite: 1]
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',[cite: 1]
      locale: 'en-US'[cite: 1]
    });[cite: 1]
    
    const page = await context.newPage();[cite: 1]

    // Отправляем VNC ссылку[cite: 1]
    const vncUrl = `${process.env.RENDER_EXTERNAL_URL}/vnc/vnc.html?autoconnect=true&resize=scale&quality=2&compression=9&path=websockify`;[cite: 1]
    await bot.api.sendMessage(chatId, `🚨 <b>Начинаю регистрацию!</b>\n\nОткрой VNC прямо сейчас:\n👉 ${vncUrl}\n\n<b>Данные бота:</b>\nПочта: <code>${acc.address}</code>\nПароль: <code>${password}</code>\nЮзернейм: <code>${ghUsername}</code>`, { parse_mode: "HTML" });[cite: 1]

    // Идем сначала на главную GitHub, чтобы поймать куки и обойти мгновенный бан[cite: 1]
    await page.goto("https://github.com", { waitUntil: "domcontentloaded", timeout: 60000 });[cite: 1]
    await page.waitForTimeout(3000); // Имитация человека[cite: 1]
    
    // Теперь идем на регистрацию[cite: 1]
    await page.goto("https://github.com/signup", { waitUntil: "domcontentloaded", timeout: 60000 });[cite: 1]

    // === НОВЫЙ БЛОК ДЛЯ НОВОГО ДИЗАЙНА GITHUB ===
    try {
      console.log("Ожидаем появления формы...");
      await page.waitForSelector('#email', { state: 'visible', timeout: 20000 });[cite: 1]
      await page.waitForTimeout(1500);[cite: 1] // Пауза как у человека[cite: 1]
      
      console.log("Заполняем данные на одной странице...");
      // Вводим данные
      await page.type('#email', acc.address, { delay: 200 });[cite: 1]
      await page.waitForTimeout(500);
      
      await page.type('#password', password, { delay: 180 });[cite: 1]
      await page.waitForTimeout(500);
      
      await page.type('#login', ghUsername, { delay: 220 });[cite: 1]
      await page.waitForTimeout(500);

      // Убираем галочку о подписке на спам, если она есть
      const optInCheckbox = await page.$('#opt_in');
      if (optInCheckbox) {
        await page.uncheck('#opt_in').catch(() => {});
      }

      // 5. Бот зовет тебя нажимать кнопку
      await bot.api.sendMessage(chatId, 
        `⏳ <b>Форма заполнена!</b>\n\n` +
        `Зайди в VNC, нажми зеленую кнопку <b>Create account</b> и пройди капчу руками.\n\n` +
        `Бот ждет 3 минуты, а потом сам пойдет искать код на почте...`, 
        { parse_mode: "HTML" }
      );

    } catch (fillError) {
      console.log("Автозаполнение не прошло:", fillError.message);[cite: 1]
      await bot.api.sendMessage(chatId, "⚠️ Бот застрял на форме. **Зайди в VNC, заполни всё сам по данным выше, пройди капчу и нажми Create Account.**\n\nБот ждет 3 минуты...", { parse_mode: "HTML" });
    }

    // Ждем, пока ТЫ пройдешь капчу и появится поле для ввода кода. Даем 3 минуты (180000 мс)
    console.log("Ждем ручного прохождения капчи...");
    // Обрабатываем оба возможных селектора поля с кодом
    await page.waitForSelector('input[name="code"], #code', { state: 'visible', timeout: 180000 });
    await bot.api.sendMessage(chatId, "✅ Вижу поле для кода! Перехватываю письмо...");[cite: 1]

    // Получение и ввод кода[cite: 1]
    const code = await getGitHubCode(acc.token);[cite: 1]
    await page.type('input[name="code"], #code', code, { delay: 150 });[cite: 1]

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => console.log("Навигация после кода не завершилась, продолжаем..."));[cite: 1]

    // Авторизация в WaveSpeed через свежий GitHub[cite: 1]
    await bot.api.sendMessage(chatId, "🚀 Аккаунт создан! Захожу в WaveSpeed...");[cite: 1]
    await page.goto("https://wavespeed.ai/login", { waitUntil: "domcontentloaded" });[cite: 1]
    
    await page.click('button:has-text("GitHub"), a:has-text("GitHub")');[cite: 1]

    try {
      await page.waitForSelector('button[name="authorize"]', { timeout: 10000 });[cite: 1]
      await page.click('button[name="authorize"]');[cite: 1]
    } catch (e) {
      // Авторизация прошла автоматически[cite: 1]
    }

    // Забираем API-ключ[cite: 1]
    await page.goto("https://wavespeed.ai/accesskey", { waitUntil: "domcontentloaded" });[cite: 1]
    await page.waitForSelector('input[readonly]');[cite: 1]
    const newApiKey = await page.inputValue('input[readonly]');[cite: 1]

    process.env.WAVESPEED_API_KEY = newApiKey;[cite: 1]
    await updateRenderEnv(newApiKey);[cite: 1]

    return newApiKey;[cite: 1]
  } catch (err) {
    // Любая ошибка перехватывается здесь[cite: 1]
    console.error("Критическая ошибка в процессе авторегистрации:", err.message);[cite: 1]
    return null;[cite: 1]
  } finally {
    // Безопасное закрытие браузера, чтобы не плодить зомби-процессы[cite: 1]
    if (browser) {
      await browser.close().catch(() => {});[cite: 1]
    }
  }
}
