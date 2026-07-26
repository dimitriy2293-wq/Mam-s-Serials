import { chromium } from "playwright";
// Убрали import node-fetch, в Node 20 он работает из коробки

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

    // 1. Идем на регистрацию (СНАЧАЛА переходим на сайт)
    await page.goto("https://wavespeed.ai/signup", { waitUntil: 'domcontentloaded' });

    try {
      // 2. Ждем поле email с увеличенным таймаутом (ПОСЛЕ перехода)
      await page.waitForSelector('input[type="email"]', { timeout: 60000 });
      // Используем account.address из сгенерированной почты
      await page.fill('input[type="email"]', account.address); 
      await page.fill('input[type="password"]', "StrongPassword123!");
      await page.click('button[type="submit"]');
    } catch (error) {
      // Делаем скриншот, если форма не появилась
      await page.screenshot({ path: 'error-debug.png' });
      console.error("Ошибка при поиске формы. Скриншот сохранен в error-debug.png");
      throw error; // Прокидываем ошибку, чтобы перейти в общий catch
    }

    // 3. Ждем письмо с кодом
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

    // 4. Вводим код
    await page.fill('input[name="code"]', code); // Подгони селектор, если он другой
    await page.click('button[type="submit"]');
    await page.waitForNavigation();

    // 5. Идем за ключом
    await page.goto("https://wavespeed.ai/accesskey");
    const newApiKey = await page.inputValue('input[readonly]'); 

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
