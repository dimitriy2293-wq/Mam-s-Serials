// lib/digen.js
const crypto = require('crypto');

class DigenAPI {
    constructor(token, deviceId = null, sessionId = null) {
        // Токен из твоего cURL, который выдается после логина/регистрации
        this.token = token; 
        this.deviceId = deviceId || crypto.randomUUID().replace(/-/g, '');
        this.sessionId = sessionId || crypto.randomUUID();
        
        this.headers = {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'digen-deviceid': this.deviceId,
            'digen-language': 'en',
            'digen-sessionid': this.sessionId,
            'digen-token': this.token,
            'origin': 'https://digen.ai',
            'referer': 'https://digen.ai/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        };
    }

    // Запуск генерации
    async generateVideo(prompt) {
        const url = 'https://api.digen.ai/v1/scene/job/submitv1';
        
        // Внутренние параметры (как в твоем cURL)
        const sceneParams = {
            video_gen_prompt: prompt,
            model_type: "standard",
            aspect_ratio_v2: "9:16",
            seconds: "5",
            engine: "rm3.5-turbo",
            generate_audio: "1"
        };

        const payload = {
            scene_id: "67",
            model: "wan",
            scene_params: JSON.stringify(sceneParams) // Сайт требует строку внутри JSON
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        // Сервер должен вернуть ID задачи (например, 40859457 из твоего cURL)
        return data.data?.id || data.id; 
    }

    // Проверка статуса и получение ссылки
    async checkStatus(jobId) {
        const url = `https://api.digen.ai/v1/queue/one?id=${jobId}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: this.headers
        });

        const data = await response.json();
        return data; 
        // Если готово, вернет что-то вроде { status: 'completed', video_url: '...' }
    }

    // Функция ожидания (поллинг)
    async waitForVideo(jobId, intervalMs = 5000) {
        console.log(`Ожидаем видео ${jobId}...`);
        while (true) {
            const statusData = await this.checkStatus(jobId);
            
            // Внимание: проверь в консоли, какое именно слово возвращает Digen (completed/success/done)
            if (statusData.data?.status === 'completed' || statusData.data?.video_url) {
                return statusData.data.video_url;
            }
            if (statusData.data?.status === 'failed') {
                throw new Error('Ошибка генерации на стороне Digen');
            }
            
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    }
}

module.exports = DigenAPI;
