import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

chromium.use(stealth());

// 1. Надежная генерация временной почты через Mail.tm
async function getMailTmAccount() {
  // Получаем доступный домен
  const domainRes = await fetch('https://api.mail.tm/domains');
  if (!domainRes.ok) throw new Error(`Ошибка API Mail.tm (домены): ${domainRes.status}`);
  const domainData = await domainRes.json();
  const domain = domainData['hydra:member'][0].domain;

  // Генерируем данные аккаунта
  const login = `botuser${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const address = `${login}@${domain}`;
  const password = `Pass!${Date.now()}#99`;

  // Создаем аккаунт
  const createRes = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password })
  });
  if (!createRes.ok) throw new Error(`Ошибка API Mail.tm (создание): ${createRes.status}`);

  // Получаем токен для чтения писем
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
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 4000)); // Ждем 4 секунды между запросами
    
    try {
      const res = await fetch(`https://api.mail.tm/messages`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      
      if (data['hydra:member'] && data['hydra:member'].length > 0) {
        const msgId = data['hydra:member'][0].id;
        
        // Получаем само тело письма
        const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const msgData = await msgRes.json();
        
        // Ищем 6-8 значный код от GitHub
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
  console.log("Запуск авторегистрации через GitHub + noVNC (через Mail.tm)...");
  let browser; // Объявляем переменную здесь, чтобы безопасно закрыть ее в блоке finally

  try {
    // Запуск браузера защищен, и добавлены флаги для экономии памяти в Docker
    // Запуск браузера с эмуляцией обычного ПК
    browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--start-maximized'
      ]
    });

    const acc = await getMailTmAccount();
    const password = `Pass!${Date.now()}#99`;
    const ghUsername = `botuser${Math.floor(Math.random() * 899999 + 100000)}`;

    // Маскируемся под обычный домашний Chrome на Windows
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    const page = await context.newPage();

    // 1. Отправляем VNC ссылку СРАЗУ (С добавлением параметра path для правильного подключения WebSocket)
   const vncUrl = `${process.env.RENDER_EXTERNAL_URL}/vnc/vnc.html?autoconnect=true&resize=scale&quality=2&compression=9&path=websockify`;
    await bot.api.sendMessage(chatId, `🚨 <b>Начинаю регистрацию!</b>\n\nОткрой VNC прямо сейчас:\n👉 ${vncUrl}\n\n<b>Данные бота:</b>\nПочта: <code>${acc.address}</code>\nПароль: <code>${password}</code>\nЮзернейм: <code>${ghUsername}</code>`, { parse_mode: "HTML" });

    // 2. Идем сначала на главную GitHub, чтобы поймать куки и обойти мгновенный бан
    await page.goto("https://github.com", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000); // Имитация человека
    
    // 3. Теперь идем на регистрацию
    await page.goto("https://github.com/signup", { waitUntil: "domcontentloaded", timeout: 60000 });

   // 4. Пытаемся заполнить форму с человеческими паузами
    try {
      await page.waitForSelector('#email', { state: 'visible', timeout: 20000 });
      await page.waitForTimeout(1500); // Пауза как у человека
      await page.type('#email', acc.address, { delay: 200 }); // Вводим медленнее
      
      const emailContinue = 'button[data-optimizely-event="click.signup_continue.email"]';
      await page.waitForSelector(emailContinue, { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.click(emailContinue);

      await page.waitForSelector('#password', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.type('#password', password, { delay: 180 });
      const passContinue = 'button[data-optimizely-event="click.signup_continue.password"]';
      await page.waitForSelector(passContinue, { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.click(passContinue);

      await page.waitForSelector('#login', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.type('#login', ghUsername, { delay: 220 });
      const loginContinue = 'button[data-optimizely-event="click.signup_continue.username"]';
      await page.waitForSelector(loginContinue, { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.click(loginContinue);

      await page.waitForSelector('#opt_in', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.type('#opt_in', 'n', { delay: 150 });
      const optContinue = 'button[data-optimizely-event="click.signup_continue.opt_in"]';
      await page.waitForSelector(optContinue, { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.click(optContinue);
    } catch (fillError) {
      console.log("Автозаполнение не прошло:", fillError.message);
      await bot.api.sendMessage(chatId, "⚠️ Бот застрял на форме. **Зайди в VNC, заполни всё сам по данным выше, пройди капчу и нажми Create Account.**\n\nБот ждет 5 минут...", { parse_mode: "HTML" });
    }

    // 5. Ждем, пока ТЫ пройдешь капчу (ждем 5 минут)
    await page.waitForSelector('input[name="code"]', { timeout: 300000 });
    await bot.api.sendMessage(chatId, "✅ Вижу поле для кода! Перехватываю письмо...");

    // 6. Получение и ввод кода
    const code = await getGitHubCode(acc.token);
    await page.type('input[name="code"]', code, { delay: 150 });

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => console.log("Навигация после кода не завершилась, продолжаем..."));

    // 7. Авторизация в WaveSpeed через свежий GitHub
    await bot.api.sendMessage(chatId, "🚀 Аккаунт создан! Захожу в WaveSpeed...");
    await page.goto("https://wavespeed.ai/login", { waitUntil: "domcontentloaded" });
    
    await page.click('button:has-text("GitHub"), a:has-text("GitHub")');

    try {
      await page.waitForSelector('button[name="authorize"]', { timeout: 10000 });
      await page.click('button[name="authorize"]');
    } catch (e) {
      // Авторизация прошла автоматически
    }

    // 8. Забираем API-ключ
    await page.goto("https://wavespeed.ai/accesskey", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[readonly]');
    const newApiKey = await page.inputValue('input[readonly]');

    process.env.WAVESPEED_API_KEY = newApiKey;
    await updateRenderEnv(newApiKey);

    return newApiKey;
  } catch (err) {
    // Любая ошибка перехватывается здесь
    console.error("Критическая ошибка в процессе авторегистрации:", err.message);
    return null;
  } finally {
    // Безопасное закрытие браузера, чтобы не плодить зомби-процессы
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
