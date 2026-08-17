// lib/tempmail.js
export async function generateEmail() {
    // Получаем 1 случайный адрес
    const res = await fetch('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1');
    const [email] = await res.json();
    return email;
}

export async function waitCodeFromDigen(email) {
    const [login, domain] = email.split('@');
    console.log(`Ожидаем письмо на ${email}...`);
    
    // Пингуем почту каждые 3 секунды (максимум 20 попыток = 60 секунд)
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        
        const res = await fetch(`https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`);
        const messages = await res.json();
        
        if (messages.length > 0) {
            // Читаем первое письмо
            const msgRes = await fetch(`https://www.1secmail.com/api/v1/?action=readMessage&login=${login}&domain=${domain}&id=${messages[0].id}`);
            const msg = await msgRes.json();
            
            // Ищем 6 цифр в тексте
            const match = msg.textBody.match(/\b(\d{6})\b/);
            if (match) {
                return match[1];
            }
        }
    }
    throw new Error("Письмо от Digen не пришло (тайм-аут)");
}
