import fetch from 'node-fetch';
import crypto from 'crypto';

let currentDigenToken = null;
let currentDeviceId = null;
let currentSessionId = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Получаем рандомный email от 1secmail
async function getTempEmail() {
    const res = await fetch('https://www.1secmail.com/api/v1/?action=getDomainList');
    const domains = await res.json();
    const domain = domains[0] || '1secmail.com';
    const login = crypto.randomBytes(5).toString('hex') + Date.now().toString().slice(-4);
    return { email: `${login}@${domain}`, login, domain };
}

// Ждём письмо с кодом
async function getCodeFromEmail(login, domain, maxRetries = 20) {
    for (let i = 0; i < maxRetries; i++) {
        await sleep(3000); // проверяем каждые 3 секунды
        const res = await fetch(`https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`);
        const messages = await res.json();
        if (messages.length > 0) {
            const msgId = messages[0].id;
            const msgRes = await fetch(`https://www.1secmail.com/api/v1/?action=readMessage&login=${login}&domain=${domain}&id=${msgId}`);
            const msg = await msgRes.json();
            // Ищем 6-значный код подтверждения в письме
            const match = msg.textBody.match(/\b\d{6}\b/);
            if (match) return match[0];
        }
    }
    throw new Error("Не удалось получить код с временной почты Digen");
}

// Регистрируем новый аккаунт
async function createDigenAccount() {
    currentDeviceId = crypto.randomBytes(16).toString('hex');
    currentSessionId = crypto.randomUUID();
    
    const { email, login, domain } = await getTempEmail();
    console.log(`[Digen] Регистрирую новый аккаунт: ${email}`);

    const baseHeaders = {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'digen-deviceid': currentDeviceId,
        'digen-language': 'en',
        'digen-sessionid': currentSessionId,
        'origin': 'https://digen.ai',
        'referer': 'https://digen.ai/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    };

    // 1. Отправляем запрос на код
    await fetch('https://api.digen.ai/v1/user/send_code', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ email, scene: "register" })
    });
    
    // 2. Ждем код
    const code = await getCodeFromEmail(login, domain);
    console.log(`[Digen] Получен код: ${code}`);
    
    // 3. Подтверждаем код
    const verifyRes = await fetch('https://api.digen.ai/v1/user/verify_code', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ email, code })
    });
    const verifyData = await verifyRes.json();
    const registerToken = verifyData?.data?.register_token || verifyData?.register_token;

    if (!registerToken) throw new Error(`Digen: нет register_token. Ответ: ${JSON.stringify(verifyData)}`);

    // 4. Задаем пароль и завершаем регистрацию
    const pwd = "ajsujAVgX$!R5A.";
    const regRes = await fetch('https://api.digen.ai/v1/user/register', {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ register_token: registerToken, password: pwd, password2: pwd })
    });
    
    const regData = await regRes.json();
    
    // 5. Вытаскиваем основной токен (из хедера или тела)
    currentDigenToken = regRes.headers.get('digen-token') || regData?.data?.token || regData?.token;
    
    if (!currentDigenToken) throw new Error("Digen: не удалось получить токен после регистрации");
    console.log("[Digen] Аккаунт успешно создан!");
}

export async function generateVideoSceneDigen(params, retry = true) {
    if (!currentDigenToken) {
        await createDigenAccount();
    }

    const sceneParams = JSON.stringify({
        image_url: params.referenceImageUrl,
        image_url_v1: params.referenceImageUrl,
        width: 384,
        height: 683,
        video_gen_prompt: params.prompt,
        aspect_ratio: "portrait",
        aspect_ratio_v2: "9:16",
        seconds: "5",
        strength: "1.0",
        engine: "rm3.5-turbo",
        generate_audio: "0"
    });

    const res = await fetch('https://api.digen.ai/v1/scene/job/submitv1', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'digen-deviceid': currentDeviceId,
            'digen-sessionid': currentSessionId,
            'digen-token': currentDigenToken,
            'origin': 'https://digen.ai',
            'referer': 'https://digen.ai/'
        },
        body: JSON.stringify({
            scene_id: "67",
            model: "wan",
            scene_params: sceneParams
        })
    });

    const data = await res.json();
    const dataStr = JSON.stringify(data).toLowerCase();
    
    // Если словили лимит, сбрасываем токен и пробуем сделать новый акк
    if (data.code !== 0 && (dataStr.includes('balance') || dataStr.includes('credit') || dataStr.includes('unauthorized') || dataStr.includes('limit'))) {
        if (retry) {
            console.log("[Digen] Лимит генераций исчерпан, делаю новый аккаунт...");
            currentDigenToken = null;
            return generateVideoSceneDigen(params, false);
        }
        throw new Error("Digen: закончились кредиты даже после создания нового аккаунта");
    }

    const jobId = data?.data?.id || data?.data?.cid || data?.id;
    if (!jobId) throw new Error(`Digen submit error: ${dataStr}`);

    return { job_id: jobId };
}

export async function checkVideoStatusDigen(jobId) {
    const res = await fetch(`https://api.digen.ai/v1/queue/one?id=${jobId}`, {
        headers: {
            'digen-deviceid': currentDeviceId,
            'digen-sessionid': currentSessionId,
            'digen-token': currentDigenToken,
            'origin': 'https://digen.ai',
            'referer': 'https://digen.ai/'
        }
    });
    
    const data = await res.json();
    const qData = data?.data || data;
    
    const status = qData.status;
    const videoUrl = qData.video_url || qData.url || qData.result_url;

    // В разных API завершение маркируется цифрами или success
    if (status === 'success' || status === 4 || status === 3 || videoUrl) {
        if (videoUrl) return { done: true, video_url: videoUrl };
    } else if (status === 'failed' || status === 'error' || status === -1) {
        return { error: true };
    }
    
    return { done: false };
}
