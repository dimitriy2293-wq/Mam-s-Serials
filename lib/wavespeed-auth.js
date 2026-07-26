import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

// Включаем плагин "невидимки" для обхода Cloudflare
chromium.use(stealth());

// Вспомогательная функция для API временной почты mail.tm
async function getTempAccount() {
  const domainRes = await fetch("https://api.mail.tm/domains");
  const domains = await domainRes.json();
  const domain = domains['hydra:member'][0].domain;

  const address = `bot${Math.floor(Math.random() * 100000)}@${domain}`;
  const password = "StrongPassword123!";

  await fetch("https://api.mail.tm/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password })
  });

  const tokenRes = await fetch("https://api.mail.tm/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password })
  });
  const { token } = await tokenRes.json();

  return { address, token };
}

// Обновление переменной в Render
async function updateRenderEnv(newKey) {
  const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.log("Нет RENDER_API_KEY/RENDER_SERVICE_ID, ключ заменен только в памяти.");
    return;
  }

  try {
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: "PUT",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RENDER_API_KEY}`
      },
      body: JSON.stringify([{ envVarName: "WAVESPEED_API_KEY", envVarValue: newKey }])
    });
    console.log("Ключ успешно обновлен в настройках Render!");
  } catch (err) {
    console.error("Ошибка обновления в Render:", err);
  }
}

export async function generateAndApplyNewKey() {
  console.log("Начинаем авторегистрацию WaveSpeed (Stealth Mode)...");
  
  const browser = await chromium.launch({ 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
  });

  try {
    const account = await getTempAccount();
    
    // Маскируем бота под обычный браузер Chrome на Windows
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      hasTouch: false,
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    
    const page = await context.newPage();

    // 1. Идем на регистрацию
    await page.goto("https://wavespeed.ai/signup", { waitUntil: 'domcontentloaded' });

    try {
      // 2. Ждем поле email (таймаут 15 секунд)
      await page.waitForSelector('input[type="email"]', { timeout: 15000 });
      await page.fill('input[type="email"]', account.address);
      await page.fill('input[type="password"]', "StrongPassword123!");
      await page.click('button[type="submit"]');
    } catch (error) {
      await page.screenshot({ path: 'error-debug.png' });
      console.error("Ошибка при поиске формы. Скорее всего Cloudflare все еще блокирует.");
      throw error;
    }

    // 3. Ждем письмо с кодом
    await page.waitForTimeout(5000);
    const messagesRes = await fetch("https://api.mail.tm/messages", {
      headers: { "Authorization": `Bearer ${account.token}` }
    });
    const messages = await messagesRes.json();
    
    if (!messages['hydra:member'] || messages['hydra:member'].length === 0) {
        throw new Error("Письмо с кодом не пришло.");
    }

    const msgId = messages['hydra:member'][0].id;

    const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, {
      headers: { "Authorization": `Bearer ${account.token}` }
    });
    const msg = await msgRes.json();
    const code = msg.text.match(/\b\d{6}\b/)[0]; // Парсим 6 цифр кода

    // 4. Вводим код
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    await page.waitForNavigation();

    // 5. Идем за ключом
    await page.goto("https://wavespeed.ai/accesskey");
    const newApiKey = await page.inputValue('input[readonly]');

    process.env.WAVESPEED_API_KEY = newApiKey;
    await updateRenderEnv(newApiKey);

    return newApiKey;
  } catch (error) {
    console.error("Ошибка в процессе авторегистрации:", error);
    return null;
  } finally {
    await browser.close();
  }
}
