import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

chromium.use(stealth());

// Временная почта 1secmail
async function get1SecMailAccount() {
  const domainsRes = await fetch("https://www.1secmail.com/api/v1/?action=getDomainList");
  const domains = await domainsRes.json();
  const domain = domains[Math.floor(Math.random() * domains.length)];
  const login = `user${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return { address: `${login}@${domain}`, login, domain };
}

async function getGitHubCode(login, domain) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`);
    const msgs = await res.json();
    if (msgs && msgs.length > 0) {
      const msgId = msgs[0].id;
      const detailRes = await fetch(`https://www.1secmail.com/api/v1/?action=readMessage&login=${login}&domain=${domain}&id=${msgId}`);
      const detail = await detailRes.json();
      const match = detail.body.match(/\b\d{6,8}\b/);
      if (match) return match[0];
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
  console.log("Запуск авторегистрации через GitHub + noVNC...");

  const browser = await chromium.launch({
    headless: false, // Запускаем на GUI виртуального экрана :99
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  try {
    const acc = await get1SecMailAccount();
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
    await page.type('#email', acc.address, { delay: 80 });
    
    // Ждем кнопку Continue
    const emailContinue = 'button[data-optimizely-event="click.signup_continue.email"]';
    await page.waitForSelector(emailContinue, { state: 'visible' });
    await page.click(emailContinue);

    await page.waitForSelector('#password', { state: 'visible' });
    await page.type('#password', password, { delay: 80 });
    const passContinue = 'button[data-optimizely-event="click.signup_continue.password"]';
    await page.waitForSelector(passContinue, { state: 'visible' });
    await page.click(passContinue);

    await page.waitForSelector('#login', { state: 'visible' });
    await page.type('#login', ghUsername, { delay: 80 });
    const loginContinue = 'button[data-optimizely-event="click.signup_continue.username"]';
    await page.waitForSelector(loginContinue, { state: 'visible' });
    await page.click(loginContinue);

    await page.waitForSelector('#opt_in', { state: 'visible' });
    await page.type('#opt_in', 'n', { delay: 80 });
    const optContinue = 'button[data-optimizely-event="click.signup_continue.opt_in"]';
    await page.waitForSelector(optContinue, { state: 'visible' });
    await page.click(optContinue);

    // 2. Отправка VNC-ссылки пользователю для прохождения капчи
    const vncUrl = `${process.env.RENDER_EXTERNAL_URL}/vnc/vnc.html?autoconnect=true&resize=scale`;
    await bot.api.sendMessage(chatId, `🚨 **Нужна помощь с капчей GitHub!**\n\nПерейди по ссылке, пройди капчу и нажми кнопку создания аккаунта:\n${vncUrl}`, { parse_mode: "Markdown" });

    // Ждем, пока начнется переход на ввод кода подтверждения почты
    await page.waitForSelector('input[name="code"]', { timeout: 180000 });
    await bot.api.sendMessage(chatId, "✅ Капча пройдена! Перехватываю письмо с кодом...");

    // 3. Получение и ввод кода
    const code = await getGitHubCode(acc.login, acc.domain);
    await page.type('input[name="code"]', code, { delay: 100 });

    await page.waitForNavigation({ waitUntil: "networkidle" });

    // 4. Авторизация в WaveSpeed через GitHub
    await page.goto("https://wavespeed.ai/login", { waitUntil: "networkidle" });
    
    // Ждем кнопку Sign in with GitHub
    await page.click('button:has-text("GitHub"), a:has-text("GitHub")');

    // Если GitHub просит подтвердить доступ OAuth
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
