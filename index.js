const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000);
require('dotenv').config();
console.log("Token Loaded:", process.env.TELEGRAM_BOT_TOKEN ? "YES" : "NO");
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

// اتصال به Claude
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
let allowedUserIds = new Set();

async function syncWhitelist() {
    try {
        const response = await fetch(process.env.GOOGLE_SHEET_CSV_URL);
        const data = await response.text();
        const rows = data.split('\n'); 
        allowedUserIds = new Set(rows.map(row => row.trim()).filter(id => id !== ""));
        console.log("Whitelist updated. Allowed users:", allowedUserIds.size);
    } catch (err) {
        console.error("Whitelist sync failed:", err);
    }
}
setInterval(syncWhitelist, 3600000); // آپدیت خودکار هر ساعت
syncWhitelist();

// دیتابیس در JSONbin برای ماندگاری در فضای ابری
async function getDB() {
    const response = await fetch(`https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}/latest`, {
        headers: { "X-Master-Key": process.env.JSONBIN_KEY }
    });
    const data = await response.json();
    return data.record;
}

async function saveDB(data) {
    await fetch(`https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}`, {
        method: 'PUT',
        headers: { 
            "Content-Type": "application/json", 
            "X-Master-Key": process.env.JSONBIN_KEY 
        },
        body: JSON.stringify(data)
    });
}

// دستورالعمل تخصصی شما
const SYSTEM_PROMPT = `
You are an expert PTE tutor. Analyze the student's SWT summary in PERSIAN.
Use ONLY clean text format (no tables, no special characters like Japanese/Chinese).

Guidelines:
1. WORD COUNT: Check if it is between 5-75 words.
2. CONTENT: Check key points and penalize outside information.
3. GRAMMAR & COHESION: Focus on conjunctions and flow.

Output Format (in Persian):
- خلاصه دانشجو: [متن اصلی]
- تعداد کلمات: [تعداد] (وضعیت: مجاز/غیرمجاز)

--- ارزیابی ---
- محتوا: [امتیاز]/5 - [توضیح کوتاه]
- فرمت: [امتیاز]/5 - [توضیح کوتاه]
- گرامر: [امتیاز]/5 - [توضیح کوتاه]
- دایره لغات: [امتیاز]/5 - [توضیح کوتاه]

--- بررسی کانکشن‌ها ---
[تحلیل دقیق ارتباط جملات و اشتباهات کلمات ربطی]

--- پیشنهادات بهبود ---
[پیشنهادات برای جایگزینی کلمات و اصلاح]

--- نسخه اصلاح شده ---
[یک نسخه بازنویسی شده حرفه‌ای]
`;



bot.on('text', async (ctx) => {
    const userId = String(ctx.from.id);
    
    // ۱. چک کردن لیست سفید
    if (!allowedUserIds.has(userId)) {
        return ctx.reply(`❌ دسترسی غیرمجاز. آیدی تلگرام شما: ${userId} در لیست دانش‌آموزان ثبت نشده است.`);
    }

    const userText = ctx.message.text;

    try {
        let db = await getDB();
        if (!db.users) db.users = {};

        if (!db.users[userId]) {
            db.users[userId] = { count: 0 };
        }

        if (db.users[userId].count >= 10) {
            return ctx.reply("❌ متأسفم، سهمیه ۱۰ تمرین شما به پایان رسیده است.");
        }

        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6", // این مدل تست شده و استاندارد است
            max_tokens: 1000,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userText }],
        });

        db.users[userId].count += 1;
        await saveDB(db);

        ctx.reply(response.content[0].text);

    } catch (error) {
        console.error(error);
        ctx.reply("⚠️ خطایی در پردازش رخ داد. لطفاً دوباره تلاش کنید.");
    }
});


bot.launch().then(() => console.log("Bot is running..."));

// برای جلوگیری از کرش کردن در سرورهای ابری
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
