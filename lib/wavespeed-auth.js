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
  let browser;

  try {
    // Запуск браузера без конфликтного --single-process
    browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const acc = await getMailTmAccount();
    const password = `Pass!${Date.now()}#99`;
    const ghUsername = `botuser${Math.floor(Math.random() * 899999 + 100000)}`;

    // Маскировка под обычный Windows Chrome
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US'
    });
    
    const page = await context.newPage();

    // Отправляем VNC ссылку
    const vncUrl = `${process.env.RENDER_EXTERNAL_URL}/vnc/vnc.html?autoconnect=true&resize=scale&quality=2&compression=9&path=websockify`;
    await bot.api.sendMessage(chatId, `🚨 <b>Начинаю регистрацию!</b>\n\nОткрой VNC прямо сейчас:\n👉 ${vncUrl}\n\n<b>Данные бота:</b>\nПочта: <code>${acc.address}</code>\nПароль: <code>${password}</code>\nЮзернейм: <code>${ghUsername}</code>`, { parse_mode: "HTML" });

    // Идем сначала на главную GitHub, чтобы поймать куки и обойти мгновенный бан
    await page.goto("https://github.com", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000); // Имитация человека
    
    // Теперь идем на регистрацию
    await page.goto("https://github.com/signup", { waitUntil: "domcontentloaded", timeout: 60000 });

    // === НОВЫЙ БЛОК ДЛЯ НОВОГО ДИЗАЙНА GITHUB ===
    try {
      console.log("Ожидаем появления формы...");
      await page.waitForSelector('#email', { state: 'visible', timeout: 20000 });
      await page.waitForTimeout(1500); // Пауза как у человека
      
      console.log("Заполняем данные на одной странице...");
      // Вводим данные
      await page.type('#email', acc.address, { delay: 200 });
      await page.waitForTimeout(500);
      
      await page.type('#password', password, { delay: 180 });
      await page.waitForTimeout(500);
      
      await page.type('#login', ghUsername, { delay: 220 });
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
      console.log("Автозаполнение не прошло:", fillError.message);
      await bot.api.sendMessage(chatId, "⚠️ Бот застрял на форме. **Зайди в VNC, заполни всё сам по данным выше, пройди капчу и нажми Create Account.**\n\nБот ждет 3 минуты...", { parse_mode: "HTML" });
    }

    // Ждем, пока ТЫ пройдешь капчу и появится поле для ввода кода. Даем 3 минуты (180000 мс)
    console.log("Ждем ручного прохождения капчи...");
    // Обрабатываем оба возможных селектора поля с кодом
    await page.waitForSelector('input[name="code"], #code', { state: 'visible', timeout: 180000 });
    await bot.api.sendMessage(chatId, "✅ Вижу поле для кода! Перехватываю письмо...");

    // Получение и ввод кода
    const code = await getGitHubCode(acc.token);
    await page.type('input[name="code"], #code', code, { delay: 150 });

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => console.log("Навигация после кода не завершилась, продолжаем..."));

    // Авторизация в WaveSpeed через свежий GitHub
    await bot.api.sendMessage(chatId, "🚀 Аккаунт создан! Захожу в WaveSpeed...");
    await page.goto("https://wavespeed.ai/login", { waitUntil: "domcontentloaded" });
    
    await page.click('button:has-text("GitHub"), a:has-text("GitHub")');

    try {
      await page.waitForSelector('button[name="authorize"]', { timeout: 10000 });
      await page.click('button[name="authorize"]');
    } catch (e) {
      // Авторизация прошла автоматически
    }

    // Забираем API-ключ
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
