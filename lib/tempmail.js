// lib/tempmail.js
export async function generateEmail() {
    // Получаем 1 случайный адрес
    const res = await fetch('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1');
    const [email] = await res.json();
    return email;
}

export async function waitCodeFromDigen(email) {
    const [login, domain] = email.split('@');
    console.log(`[TempMail] Ожидаем письмо от Digen на ${email}...`);
    
    // Пингуем почту каждые 3 секунды (максимум 25 попыток = 75 секунд)
    for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 3000));
        
        try {
            const res = await fetch(`https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`);
            const messages = await res.json();
            
            if (messages.length > 0) {
                // Читаем первое письмо
                const msgRes = await fetch(`https://www.1secmail.com/api/v1/?action=readMessage&login=${login}&domain=${domain}&id=${messages[0].id}`);
                const msg = await msgRes.json();
                
                // Ищем 6 цифр подряд в тексте письма (код верификации)
                const match = msg.textBody.match(/\b(\d{6})\b/);
                if (match) {
                    return match[1];
                }
            }
        } catch (err) {
            console.error(`[TempMail] Ошибка при проверке почты: ${err.message}`);
        }
    }
    throw new Error("Письмо с кодом от Digen не пришло (тайм-аут).");
}
