import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import path from "path";
import { uploadToStorage } from "./storage.js";

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

// ВОТ ЭТУ СТРОЧКУ ТЫ СЛУЧАЙНО УДАЛИЛ В ПРОШЛЫЙ РАЗ :)
export async function generateAndApplyNewKey() {
  console.log("Начинаем авторегистрацию WaveSpeed (Stealth Mode)...");
  
  const browser = await chromium.launch({ 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const account = await getTempAccount();
    
    // Маскируем бота под обычный браузер Chrome на Windows
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      hasTouch: false,
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    
    const page = await context.newPage();

    // 1. Идем на регистрацию (увеличили таймаут до 60 сек и ждем окончания сетевых запросов)
    await page.goto("https://accounts.google.com/v3/signin/accountchooser?client_id=402640071865-tg697lv1iddumf2ssl0fmri0uf7m8rvr.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fwavespeed.ai%2Fcenter%2Fdefault%2Fgoogle%2Fcallback&response_type=code&scope=openid+profile+email&state=v1.eyJwcm92aWRlciI6Imdvb2dsZSIsInJlZGlyZWN0X3BhdGgiOiIvIiwibm9uY2UiOiI2SmVyMzBYZzBneWJTRlU1Wjk0aWlZb2xLbVE0T2JxTVF5YUNfMzRZTEZvIiwiZXhwaXJlc19hdCI6MTc4NTA2NzYyNSwicmVkaXNfYmFja2VkIjp0cnVlfQ.4gw9wHm_-rOWiqwgHljDLwZYx4weYhtpfClUhnJIjRA&dsh=S1845697537%3A1785067026009560&o2v=1&service=lso&flowName=GeneralOAuthFlow&opparams=%253F&continue=https%3A%2F%2Faccounts.google.com%2Fsignin%2Foauth%2Fconsent%3Fauthuser%3Dunknown%26part%3DAJi8hAOH38op6jtQwqHdUrCebwMCk-pjJtoY8PfqOy4AP5HfB4TcPFaibWblOwb0T-XidcSpWs2UQRx1q3zGM8Pk8gp3M9sFIAbxPLq5QgA8fFIbvQE0b9v6TbHNhEEfLdEw04Kk-b4f9egDu28tGsHnY73t2drsLXJQREmaPeGXtRP21yrao7RWhvD8ro7gCSbZC5_PpoiB4v-hMm1bSuEtjvjrCocNmJQHC7NF5bAck-sTxaDktwpj_kjFj57wdLU32LG9LpzRfrfLQoO0mMHkEO4NaTcA2quaDe4Ifr817o2XVTS0K7xQi_PZR3SaVxQYd1lYmljZR9rbBOkQBHwjWxuzknlD37haVXaAWqCyhOzzXAcD8UsNWG2KhoJqBTyzs025VJQ_jrUgx3v3n2QhZ6Edh5IOTaHe6P2DajoksF2iGQZq6Lkr5R6pOvI9ps9XN4chKJo6IFpdJhIZvFItMrFyoNCNLw%26flowName%3DGeneralOAuthFlow%26as%3DS1845697537%253A1785067026009560%26client_id%3D402640071865-tg697lv1iddumf2ssl0fmri0uf7m8rvr.apps.googleusercontent.com%26requestPath%3D%252Fsignin%252Foauth%252Fconsent%23&app_domain=https%3A%2F%2Fwavespeed.ai", { waitUntil: 'networkidle', timeout: 60000 });

    try {
      // 2. Ждем поле email (таймаут 30 секунд)
      await page.waitForSelector('input[type="email"]', { timeout: 30000 });
      await page.fill('input[type="email"]', account.address);
      await page.fill('input[type="password"]', "StrongPassword123!");
      await page.click('button[type="submit"]');
    } catch (error) {
      const debugPath = path.join("/tmp", `error-debug-${Date.now()}.png`);
      await page.screenshot({ path: debugPath });
      
      try {
        const debugUrl = await uploadToStorage(debugPath, "debug");
        console.error(`Cloudflare заблокировал доступ. Посмотреть скриншот: ${debugUrl}`);
      } catch (uploadErr) {
        console.error("Не удалось загрузить скриншот ошибки в Storage", uploadErr);
      }
      
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
