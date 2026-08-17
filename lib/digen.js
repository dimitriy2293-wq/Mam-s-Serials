// lib/digen.js
import crypto from 'crypto';
import { generateEmail, waitCodeFromDigen } from './tempmail.js';

export class DigenAPI {
    constructor() {
        this.deviceId = crypto.randomUUID().replace(/-/g, '');
        this.sessionId = crypto.randomUUID();
        this.token = null;
        this.headers = {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'digen-deviceid': this.deviceId,
            'digen-language': 'en',
            'digen-sessionid': this.sessionId,
            'origin': 'https://digen.ai',
            'referer': 'https://digen.ai/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0'
        };
    }

    // Полный цикл: почта -> код -> токен
    async registerAndAuth() {
        const email = await generateEmail();
        
        // 1. Отправляем код
        await fetch('https://api.digen.ai/v1/user/send_code', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ email: email, scene: "register" })
        });

        // 2. Ждем код на почту
        const code = await waitCodeFromDigen(email);
        
        // 3. Верифицируем
        const verifyRes = await fetch('https://api.digen.ai/v1/user/verify_code', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ email, code })
        });
        const verifyData = await verifyRes.json();
        const registerToken = verifyData.data.register_token;

        // 4. Регистрация
        const regRes = await fetch('https://api.digen.ai/v1/user/register', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                register_token: registerToken,
                password: "Password123!",
                password2: "Password123!"
            })
        });
        
        const regData = await regRes.json();
        this.token = regData.data.token;
        this.headers['digen-token'] = this.token;
        
        return this.token;
    }

    async generateVideo(prompt) {
        if (!this.token) await this.registerAndAuth();

        const payload = {
            scene_id: "67",
            model: "wan",
            scene_params: JSON.stringify({
                video_gen_prompt: prompt,
                model_type: "standard",
                aspect_ratio_v2: "9:16",
                seconds: "5",
                engine: "rm3.5-turbo",
                generate_audio: "1"
            })
        };

        const response = await fetch('https://api.digen.ai/v1/scene/job/submitv1', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        const jobId = data.data?.id || data.id;

        return this.waitForVideo(jobId);
    }

    async waitForVideo(jobId) {
        while (true) {
            const res = await fetch(`https://api.digen.ai/v1/queue/one?id=${jobId}`, {
                headers: this.headers
            });
            const data = await res.json();
            
            if (data.data?.status === 'completed' || data.data?.video_url) {
                return data.data.video_url; // Возвращаем прямую ссылку на видео
            }
            if (data.data?.status === 'failed') throw new Error('Digen не смог сгенерировать видео');
            
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}
