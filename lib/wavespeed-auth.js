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

export async function generateAndApplyNewKey(bot, chatId) {
  console.log("Запуск авторегистрации через GitHub + noVNC (через Mail.tm)...");

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  try {
    // Получаем новую почту через новый API
    const acc = await getMailTmAccount();
    const password = `Pass!${Date.now()}#99`;
    const ghUsername = `botuser${Math.floor(Math.random() * 899999 + 100000)}`;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    // 1. Идем на регистрацию GitHub
    await page.goto("https://github.com/signup", { waitUntil: "networkidle" });

    // Пошаговое заполнение с имитацией ввода человека
    await page.waitForSelector('#email');
    await page.type('#email', acc.address, { delay: 100 });
    
    // Ждем кнопку Continue (оборачиваем в try/catch на случай изменения верстки Гитхаба)
    try {
      const emailContinue = 'button[data-optimizely-event="click.signup_continue.email"]';
      await page.waitForSelector(emailContinue, { state: 'visible', timeout: 5000 });
      await page.click(emailContinue);

      await page.waitForSelector('#password', { state: 'visible', timeout: 5000 });
      await page.type('#password', password, { delay: 100 });
      const passContinue = 'button[data-optimizely-event="click.signup_continue.password"]';
      await page.waitForSelector(passContinue, { state: 'visible', timeout: 5000 });
      await page.click(passContinue);

      await page.waitForSelector('#login', { state: 'visible', timeout: 5000 });
      await page.type('#login', ghUsername, { delay: 100 });
      const loginContinue = 'button[data-optimizely-event="click.signup_continue.username"]';
      await page.waitForSelector(loginContinue, { state: 'visible', timeout: 5000 });
      await page.click(loginContinue);

      await page.waitForSelector('#opt_in', { state: 'visible', timeout: 5000 });
      await page.type('#opt_in', 'n', { delay: 100 });
      const optContinue = 'button[data-optimizely-event="click.signup_continue.opt_in"]';
      await page.waitForSelector(optContinue, { state: 'visible', timeout: 5000 });
      await page.click(optContinue);
    } catch (e) {
      console.log("Автоматический клик 'Continue' не удался. Требуется помощь в VNC.");
    }

    // 2. Отправка VNC-ссылки пользователю для прохождения капчи
    const vncUrl = `${process.env.RENDER_EXTERNAL_URL}/vnc/vnc.html?autoconnect=true&resize=scale`;
    await bot.api.sendMessage(chatId, `🚨 **Нужна помощь!**\n\nБот ввел данные. Перейди по ссылке, **прокликай кнопки 'Continue', если бот застрял**, реши капчу и нажми 'Create account':\n\n${vncUrl}\n\n*Бот ждет появления поля ввода кода с почты (у тебя есть 3 минуты)...*`, { parse_mode: "Markdown" });

    // Ждем, пока ты пройдешь капчу и появится поле ввода кода
    await page.waitForSelector('input[name="code"]', { timeout: 180000 });
    await bot.api.sendMessage(chatId, "✅ Вижу поле для кода! Перехватываю письмо...");

    // 3. Получение и ввод кода (Используем токен Mail.tm)
    const code = await getGitHubCode(acc.token);
    await page.type('input[name="code"]', code, { delay: 150 });

    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }).catch(() => console.log("Навигация после кода не завершилась, продолжаем..."));

    // 4. Авторизация в WaveSpeed через свежий GitHub
    await bot.api.sendMessage(chatId, "🚀 Аккаунт создан! Захожу в WaveSpeed...");
    await page.goto("https://wavespeed.ai/login", { waitUntil: "networkidle" });
    
    await page.click('button:has-text("GitHub"), a:has-text("GitHub")');

    try {
      await page.waitForSelector('button[name="authorize"]', { timeout: 10000 });
      await page.click('button[name="authorize"]');
    } catch (e) {
      // Авторизация прошла автоматически
    }

    // 5. Забираем API-ключ
    await page.goto("https://wavespeed.ai/accesskey", { waitUntil: "networkidle" });
    await page.waitForSelector('input[readonly]');
    const newApiKey = await page.inputValue('input[readonly]');

    process.env.WAVESPEED_API_KEY = newApiKey;
    await updateRenderEnv(newApiKey);

    return newApiKey;
  } catch (err) {
    console.error("Ошибка в процессе авторегистрации:", err);
    return null;
  } finally {
    await browser.close();
  }
}
