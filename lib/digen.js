// lib/digen.js
import crypto from 'crypto';
import { generateEmail, waitCodeFromDigen } from './tempmail.js';

export class DigenAPI {
    constructor() {
        this.deviceId = crypto.randomUUID().replace(/-/g, '');
        this.sessionId = crypto.randomUUID();
        this.token = null;
        
        // Заголовки строго как в твоем curl, чтобы имитировать реальный браузер
        this.headers = {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'ru,en-US;q=0.9,en;q=0.8,uk;q=0.7',
            'content-type': 'application/json',
            'digen-deviceid': this.deviceId,
            'digen-language': 'en',
            'digen-sessionid': this.sessionId,
            'origin': 'https://digen.ai',
            'priority': 'u=1, i',
            'referer': 'https://digen.ai/',
            'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-site',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        };
    }

    // Полный цикл: почта -> код -> токен
    async registerAndAuth() {
        const email = await generateEmail();
        console.log(`[Digen] Используем почту: ${email}`);
        
        // 1. Отправляем код
        const sendRes = await fetch('https://api.digen.ai/v1/user/send_code', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ email: email, scene: "register" })
        });
        if (!sendRes.ok) throw new Error(`Ошибка send_code: HTTP ${sendRes.status}`);

        // 2. Ждем код на почту
        const code = await waitCodeFromDigen(email);
        console.log(`[Digen] Получен код: ${code}`);
        
        // 3. Верифицируем код
        const verifyRes = await fetch('https://api.digen.ai/v1/user/verify_code', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ email, code })
        });
        const verifyData = await verifyRes.json();
        
        if (!verifyData.data || !verifyData.data.register_token) {
            throw new Error('Не удалось получить register_token от Digen');
        }
        const registerToken = verifyData.data.register_token;

        // 4. Регистрация (пароль из твоего curl)
        const password = "ajsujAVgX$!R5A."; 
        const regRes = await fetch('https://api.digen.ai/v1/user/register', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                register_token: registerToken,
                password: password,
                password2: password
            })
        });
        
        const regData = await regRes.json();
        if (!regData.data || !regData.data.token) {
            throw new Error('Не удалось получить токен авторизации');
        }
        
        this.token = regData.data.token;
        this.headers['digen-token'] = this.token;
        console.log(`[Digen] Успешная регистрация и авторизация!`);
        
        return this.token;
    }

    async generateVideo(prompt) {
        if (!this.token) await this.registerAndAuth();

        // Формируем payload на основе твоего curl запроса
        const payload = {
            scene_id: "67",
            model: "wan",
            scene_params: JSON.stringify({
                width: 384,
                height: 683,
                video_gen_prompt: prompt,
                lipsync: "2",
                aspect_ratio: "portrait",
                aspect_ratio_v2: "9:16",
                seconds: "5",
                strength: "1.0",
                resolution: "352x608",
                engine: "rm3.5-turbo",
                generate_audio: "1",
                generation_type: "frame",
                model_type: "standard"
            })
        };

        const response = await fetch('https://api.digen.ai/v1/scene/job/submitv1', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.code !== 0 || !data.data) {
            throw new Error(`Ошибка API Digen при отправке видео: ${JSON.stringify(data)}`);
        }
        
        const jobId = data.data.id || data.data.code; // В зависимости от того, что возвращает API
        console.log(`[Digen] Видео отправлено в очередь. ID задачи: ${jobId}`);

        return this.waitForVideo(jobId);
    }

    async waitForVideo(jobId) {
        let attempts = 0;
        while (attempts < 60) { // Ждем максимум ~5 минут (60 попыток по 5 сек)
            attempts++;
            const res = await fetch(`https://api.digen.ai/v1/queue/one?id=${jobId}`, {
                headers: this.headers
            });
            const data = await res.json();
            
            if (data.data?.status === 'completed' || data.data?.video_url) {
                return data.data.video_url; // Возвращаем прямую ссылку на видео
            }
            if (data.data?.status === 'failed' || data.data?.status === 'error') {
                throw new Error('Digen не смог сгенерировать видео (статус failed)');
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        throw new Error('Превышено время ожидания генерации видео в Digen.');
    }
}
