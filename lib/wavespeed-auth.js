export async function generateAndApplyNewKey(bot, chatId) {
  console.log("Запуск авторегистрации через GitHub + noVNC (через Mail.tm)...");

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  try {
    const acc = await getMailTmAccount();
    const password = `Pass!${Date.now()}#99`;
    const ghUsername = `botuser${Math.floor(Math.random() * 899999 + 100000)}`;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    // 1. Отправляем VNC ссылку СРАЗУ, чтобы ты мог контролировать процесс с 1 секунды
    const vncUrl = `${process.env.RENDER_EXTERNAL_URL}/vnc/vnc.html?autoconnect=true&resize=scale`;
    await bot.api.sendMessage(chatId, `🚨 **Начинаю регистрацию!**\n\nОткрой VNC прямо сейчас. Гитхаб может выдать капчу еще до ввода почты!\n👉 ${vncUrl}\n\n**Данные бота, если придется вводить руками:**\nПочта: \`${acc.address}\`\nПароль: \`${password}\`\nЮзернейм: \`${ghUsername}\``, { parse_mode: "Markdown" });

    // 2. Идем на регистрацию GitHub (меняем networkidle на domcontentloaded)
    await page.goto("https://github.com/signup", { waitUntil: "domcontentloaded", timeout: 60000 });

    // 3. Пытаемся заполнить форму, но не падаем, если не вышло
    try {
      await page.waitForSelector('#email', { state: 'visible', timeout: 20000 });
      await page.type('#email', acc.address, { delay: 100 });
      
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
    } catch (fillError) {
      console.log("Автозаполнение не прошло:", fillError.message);
      await bot.api.sendMessage(chatId, "⚠️ Бот застрял на форме (скорее всего защита Гитхаба). **Зайди в VNC, заполни всё сам по данным выше, пройди капчу и нажми Create Account.**\n\nБот ждет 5 минут...");
    }

    // 4. Ждем, пока ТЫ пройдешь капчу и появится поле ввода кода (даем целых 5 минут на ручные действия)
    await page.waitForSelector('input[name="code"]', { timeout: 300000 });
    await bot.api.sendMessage(chatId, "✅ Вижу поле для кода! Перехватываю письмо...");

    // 5. Получение и ввод кода
    const code = await getGitHubCode(acc.token);
    await page.type('input[name="code"]', code, { delay: 150 });

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => console.log("Навигация после кода не завершилась, продолжаем..."));

    // 6. Авторизация в WaveSpeed через свежий GitHub
    await bot.api.sendMessage(chatId, "🚀 Аккаунт создан! Захожу в WaveSpeed...");
    await page.goto("https://wavespeed.ai/login", { waitUntil: "domcontentloaded" });
    
    await page.click('button:has-text("GitHub"), a:has-text("GitHub")');

    try {
      await page.waitForSelector('button[name="authorize"]', { timeout: 10000 });
      await page.click('button[name="authorize"]');
    } catch (e) {
      // Авторизация прошла автоматически
    }

    // 7. Забираем API-ключ
    await page.goto("https://wavespeed.ai/accesskey", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[readonly]');
    const newApiKey = await page.inputValue('input[readonly]');

    process.env.WAVESPEED_API_KEY = newApiKey;
    await updateRenderEnv(newApiKey);

    return newApiKey;
  } catch (err) {
    console.error("Критическая ошибка в процессе авторегистрации:", err);
    return null;
  } finally {
    await browser.close();
  }
}
