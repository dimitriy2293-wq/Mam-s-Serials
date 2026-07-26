import { chromium } from "playwright";
import fetch from "node-fetch";

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
  console.log("Начинаем авторегистрацию WaveSpeed...");
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  
  try {
    const account = await getTempAccount();
    const context = await browser.newContext();
    const page = await context.newPage();


    // В lib/wavespeed-auth.js (около 64 строки)
  // Увеличиваем таймаут до 60 секунд
  await page.waitForSelector('input[type="email"]', { timeout: 60000 });
  await page.fill('input[type="email"]', emailAddress);
} catch (error) {
  // Делаем скриншот страницы, чтобы понять, на чем мы застряли (капча, Cloudflare, недогруз)
  await page.screenshot({ path: 'error-debug.png' });
  console.error("Ошибка при поиске поля. Скриншот сохранен в error-debug.png");
  throw error;
}
    // 1. Идем на регистрацию
    await page.goto("https://wavespeed.ai/signup");
    await page.fill('input[type="email"]', account.address);
    await page.fill('input[type="password"]', "StrongPassword123!");
    await page.click('button[type="submit"]');

    // 2. Ждем письмо с кодом
    await page.waitForTimeout(5000); 
    const messagesRes = await fetch("https://api.mail.tm/messages", {
      headers: { "Authorization": `Bearer ${account.token}` }
    });
    const messages = await messagesRes.json();
    const msgId = messages['hydra:member'][0].id;
    
    const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, {
      headers: { "Authorization": `Bearer ${account.token}` }
    });
    const msg = await msgRes.json();
    const code = msg.text.match(/\b\d{6}\b/)[0]; // Парсим 6 цифр кода

    // 3. Вводим код
    await page.fill('input[name="code"]', code); // Подгони селектор, если он другой
    await page.click('button[type="submit"]');
    await page.waitForNavigation();

    // 4. Идем за ключом
    await page.goto("https://wavespeed.ai/accesskey");
    const newApiKey = await page.inputValue('input[readonly]'); // Предполагаемый селектор ключа

    // Применяем ключ прямо сейчас в памяти (бот подхватит сразу)
    process.env.WAVESPEED_API_KEY = newApiKey;
    
    // Сохраняем в Render (чтобы не слетело при рестарте)
    await updateRenderEnv(newApiKey);

    return newApiKey;
  } catch (error) {
    console.error("Ошибка в процессе авторегистрации:", error);
    return null;
  } finally {
    await browser.close();
  }
}
