```javascript
require('dotenv').config();

const http = require('http');
const { chromium } = require('playwright');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const EMBASSY_URL = 'https://appointment.afghanembassy.berlin/';
const CHAT_FILE = './chat_id.txt';
const PORT = process.env.PORT || 10000;

if (!TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN پیدا نشد.');
    process.exit(1);
}

// --------------------------------------------------
// Render Health Server
// --------------------------------------------------

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Embassy Checker is running.');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health server running on port ${PORT}`);
});

// --------------------------------------------------
// Telegram
// --------------------------------------------------

const bot = new TelegramBot(TOKEN, {
    polling: true
});

let chatId = null;
let checking = false;

if (fs.existsSync(CHAT_FILE)) {
    chatId = fs.readFileSync(CHAT_FILE, 'utf8').trim();
}

// --------------------------------------------------
// Telegram Message
// --------------------------------------------------

async function sendTelegram(message) {
    if (!chatId) {
        console.log('⚠️ Chat ID نداریم. در Telegram /start بفرست.');
        return;
    }

    try {
        await bot.sendMessage(chatId, message);
    } catch (error) {
        console.log('❌ خطای Telegram:', error.message);
    }
}

// --------------------------------------------------
// No Appointment Detection
// --------------------------------------------------

function noAppointment(text) {
    const t = text
        .toLowerCase()
        .replace(/\s+/g, ' ');

    const phrases = [
        'es gibt leider keine freien termine',
        'keine freien termine',
        'keine verfügbaren termine',
        'keine termine verfügbar',
        'keine termine',
        'no available appointments',
        'no available appointment',
        'no appointments available'
    ];

    return phrases.some(phrase => t.includes(phrase));
}

// --------------------------------------------------
// Find Times
// --------------------------------------------------

function findTimes(text) {
    const matches = text.match(
        /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g
    );

    return matches ? [...new Set(matches)] : [];
}

// --------------------------------------------------
// Select First Real Option
// --------------------------------------------------

async function selectFirstRealOption(select) {
    const options = await select.locator('option').evaluateAll(opts =>
        opts.map(o => ({
            text: (o.textContent || '').trim(),
            value: o.value,
            disabled: o.disabled
        }))
    );

    const usable = options.find(o => {
        if (o.disabled) return false;
        if (!o.value) return false;

        return !/select|choose|auswählen|bitte|provider|service/i.test(
            o.text
        );
    });

    if (!usable) {
        return false;
    }

    try {
        await select.selectOption(usable.value);

        console.log(`✅ گزینه انتخاب شد: ${usable.text}`);

        return true;
    } catch (error) {
        console.log(`⚠️ انتخاب گزینه ممکن نبود: ${error.message}`);
        return false;
    }
}

// --------------------------------------------------
// Check Embassy
// --------------------------------------------------

async function checkAppointments(notify = true) {
    if (checking) {
        console.log('⏳ بررسی قبلی هنوز تمام نشده.');
        return;
    }

    checking = true;

    let browser = null;

    try {
        console.log('\n--------------------------------');
        console.log(
            '🔎 شروع بررسی:',
            new Date().toLocaleString('de-DE')
        );
        console.log('--------------------------------');

        browser = await chromium.launch({
            headless: true
        });

        const page = await browser.newPage({
            viewport: {
                width: 1400,
                height: 1000
            }
        });

        await page.goto(EMBASSY_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.waitForTimeout(3000);

        console.log('🌐 سایت باز شد.');

        // --------------------------------------------------
        // Service & Provider
        // --------------------------------------------------

        const selects = page.locator('select:visible');
        const selectCount = await selects.count();

        console.log(
            '📋 Selectهای قابل مشاهده:',
            selectCount
        );

        for (let i = 0; i < selectCount; i++) {
            const select = selects.nth(i);

            await selectFirstRealOption(select);

            await page.waitForTimeout(1500);
        }

        // --------------------------------------------------
        // Current Page Text
        // --------------------------------------------------

        let text = await page.locator('body').innerText();

        if (noAppointment(text)) {
            console.log('🔴 هیچ وقت آزادی وجود ندارد.');

            if (notify) {
                await sendTelegram(
                    '🔴 بررسی سفارت انجام شد.\n\n' +
                    '❌ در حال حاضر وقت آزاد وجود ندارد.\n\n' +
                    '🕐 پنج دقیقه دیگر دوباره بررسی می‌کنم.'
                );
            }

            return;
        }

        // --------------------------------------------------
        // Next
        // --------------------------------------------------

        const nextButtons = page.getByRole('button', {
            name: /^Next$/i
        });

        const nextCount = await nextButtons.count();

        console.log(
            '➡️ دکمه Next:',
            nextCount
        );

        if (nextCount > 0) {
            await nextButtons.first().click();

            console.log(
                '➡️ وارد مرحله Appointment Date & Time شدیم.'
            );

            await page.waitForTimeout(5000);
        }

        // --------------------------------------------------
        // Appointment Page
        // --------------------------------------------------

        text = await page.locator('body').innerText();

        console.log('📅 صفحه Appointment بررسی شد.');

        console.log(text.substring(0, 1500));

        // --------------------------------------------------
        // No Appointment
        // --------------------------------------------------

        if (noAppointment(text)) {
            console.log(
                '🔴 نتیجه: وقت آزاد وجود ندارد.'
            );

            if (notify) {
                await sendTelegram(
                    '🔴 بررسی انجام شد.\n\n' +
                    '❌ هیچ وقت آزادی پیدا نشد.\n\n' +
                    '🕐 بررسی بعدی: ۵ دقیقه دیگر.'
                );
            }

            return;
        }

        // --------------------------------------------------
        // Find Times
        // --------------------------------------------------

        const times = findTimes(text);

        if (times.length > 0) {
            console.log(
                '🟢 ساعت پیدا شد:',
                times
            );

            await sendTelegram(
                '🟢🚨 وقت احتمالی پیدا شد!\n\n' +
                'ساعت‌های پیدا شده:\n' +
                times.join('، ') +
                '\n\n' +
                '⚠️ سریع سایت را بررسی کن:\n' +
                EMBASSY_URL
            );

            return;
        }

        // --------------------------------------------------
        // Clickable Elements
        // --------------------------------------------------

        const clickable = await page.locator(
            'button:visible:not([disabled]), ' +
            'input:visible:not([disabled]), ' +
            '[role="button"]:visible'
        ).evaluateAll(elements => {
            return elements
                .map(e => ({
                    text: (
                        e.innerText ||
                        e.value ||
                        e.getAttribute('aria-label') ||
                        ''
                    ).trim()
                }))
                .filter(x => x.text.length > 0);
        });

        console.log(
            '🔘 عناصر قابل انتخاب:',
            clickable.slice(0, 30)
        );

        // --------------------------------------------------
        // Date Detection
        // --------------------------------------------------

        const datePattern =
            /\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])(?:[./-]\d{2,4})?\b/;

        const possibleDates = clickable.filter(
            x => datePattern.test(x.text)
        );

        if (possibleDates.length > 0) {
            console.log(
                '🟢 تاریخ قابل انتخاب پیدا شد:',
                possibleDates
            );

            await sendTelegram(
                '🟢🚨 احتمال باز شدن وقت وجود دارد!\n\n' +
                'تاریخ قابل انتخاب در صفحه پیدا شد.\n\n' +
                '⚠️ سریع سایت را باز کن:\n' +
                EMBASSY_URL
            );

            return;
        }

        // --------------------------------------------------
        // Unknown
        // --------------------------------------------------

        console.log(
            '🟡 وقت آزاد قطعی تشخیص داده نشد.'
        );

        if (notify) {
            await sendTelegram(
                '🟡 بررسی انجام شد.\n\n' +
                'ربات پیام «بدون وقت» را پیدا نکرد، ' +
                'اما وقت آزاد هم به‌صورت قطعی تشخیص داده نشد.\n\n' +
                '🕐 پنج دقیقه دیگر دوباره بررسی می‌کنم.'
            );
        }

    } catch (error) {

        console.log(
            '❌ خطا:',
            error.message
        );

        if (notify) {
            await sendTelegram(
                '⚠️ هنگام بررسی سایت خطا رخ داد.\n\n' +
                'ربات پنج دقیقه دیگر دوباره تلاش می‌کند.'
            );
        }

    } finally {

        if (browser) {
            try {
                await browser.close();
            } catch {}
        }

        checking = false;
    }
}

// ==================================================
// /start
// ==================================================

bot.onText(/^\/start$/, async msg => {

    chatId = String(msg.chat.id);

    fs.writeFileSync(
        CHAT_FILE,
        chatId,
        'utf8'
    );

    console.log(
        '👤 Chat ID ذخیره شد:',
        chatId
    );

    await bot.sendMessage(
        chatId,
        '🤖 ربات آماده است.\n\n' +
        '✅ بررسی خودکار فعال است.\n' +
        '⏰ هر ۵ دقیقه سایت سفارت را بررسی می‌کنم.\n\n' +
        'اگر خواستی همین الان دستی بررسی کنم:\n' +
        '/check'
    );
});

// ==================================================
// /check
// ==================================================

bot.onText(/^\/check$/, async msg => {

    chatId = String(msg.chat.id);

    fs.writeFileSync(
        CHAT_FILE,
        chatId,
        'utf8'
    );

    await bot.sendMessage(
        chatId,
        '🔎 بررسی دستی شروع شد...'
    );

    await checkAppointments(true);
});

// ==================================================
// Automatic Checking
// ==================================================

console.log(
    '⏰ بررسی خودکار هر ۵ دقیقه فعال است.'
);

setTimeout(async () => {

    console.log(
        '🚀 اولین بررسی خودکار شروع شد.'
    );

    await checkAppointments(true);

    setInterval(async () => {

        console.log(
            '\n⏰ پنج دقیقه گذشت؛ بررسی جدید شروع می‌شود.'
        );

        await checkAppointments(true);

    }, 5 * 60 * 1000);

}, 5000);const PORT = process.env.PORT || 10000;

require('http')
  .createServer((req, res) => {
    res.writeHead(200);
    res.end('Embassy checker is running');
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server listening on port ${PORT}`);
  });
```

