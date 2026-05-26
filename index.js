require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// --- Admin & Whitelist ---
const ADMIN_IDS = new Set(["97660313", "108265666", "6190801722"]);
const isAdmin = (id) => ADMIN_IDS.has(String(id));
let allowedUserIds = new Set();

async function syncWhitelist() {
    try {
        const response = await fetch(process.env.GOOGLE_SHEET_CSV_URL, { headers: { "Cache-Control": "no-cache" } });
        const data = await response.text();
        const rows = data.split('\n')
            .map(row => row.replace('\r', '').trim())
            .filter(row => row !== "" && !isNaN(row));
        allowedUserIds = new Set(rows);
    } catch (err) { console.error("Whitelist sync failed:", err); }
}
setInterval(syncWhitelist, 300000);
syncWhitelist();

// --- DB Logic (JSONBin.io) ---
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}`;
const JSONBIN_HEADERS = {
    "Content-Type": "application/json",
    "X-Master-Key": process.env.JSONBIN_API_KEY
};

async function getDB() {
    const response = await fetch(JSONBIN_URL, { headers: JSONBIN_HEADERS });
    if (!response.ok) throw new Error(`DB Fetch Failed: ${response.statusText}`);
    const data = await response.json();
    return data.record?.users ? data.record : { users: {} };
}

async function saveDB(data) {
    try {
        const response = await fetch(JSONBIN_URL, {
            method: 'PUT',
            headers: JSONBIN_HEADERS,
            body: JSON.stringify(data)
        });
        if (!response.ok) console.error("DB Save Failed:", response.statusText);
    } catch (err) {
        console.error("DB Save Error:", err);
    }
}

const LIMIT = 10;

// returns { db, migrated }
function ensureUser(db, userId) {
    if (!db.users) db.users = {};
    let migrated = false;
    if (!db.users[userId]) {
        db.users[userId] = { count: 0, limit: LIMIT };
        migrated = true;
    } else if (db.users[userId].limit === undefined) {
        db.users[userId].limit = LIMIT;
        migrated = true;
    }
    return { db, migrated };
}

// --- Prompt Setup (UNTOUCHED) ---
const SYSTEM_PROMPT = `You are an expert PTE tutor. Analyze the student's SWT (Summarize Written Text) with high pedagogical detail.
IMPORTANT: Always start the message with "📋" to fix RTL direction. Use Markdown.
⚠️ IMPORTANT PTE RULE: If the word count is more than 75 words, the score is automatically ZERO.

Output Format:
📋 **تحلیل تخصصی SWT:**

---

📊 **تحلیل آماری:**
• تعداد کلمات: [عدد] کلمه
• [در صورت بالای ۷۵ کلمه: ⚠️ هشدار بحرانی: بیش از ۷۵ کلمه = نمره صفر خودکار!]
• محتوا: [امتیاز] از 5
• فرمت: [امتیاز] از 5

---

🔗 **تحلیل و کالبدشکافی کانکشن‌های دانشجو:**

• **کانکشن‌های صحیح:**
  - [توضیح استفاده درست از کانکتورها و منطق اتصال]

• **کانکشن‌های دارای ایراد:**
  - **ایراد [شماره]:** [توضیح کامل و تشریحی ایراد به فارسی]
  - عبارت اصلی دانشجو: \`[عبارت]\`
  - پیشنهاد اصلاح: \`[اصلاح شده]\`

---

💡 **نکات کلیدی برای بهبود متن دانشجو:**
• [نکات استراتژیک و گرامری]

---

✍️ **نسخه اصلاح شده جمله دانشجو:**
\`[یک نسخه اصلاح شده و استاندارد از تلاش دانشجو]\`
(تعداد کلمات: [عدد] ✅)

---

🎯 **جملات کلیدی پیشنهادی (AI Selection):**
• جملات منتخب:
  \`[۱]\`
  \`[۲]\`
  \`[۳]\`
• دلیل اهمیت (فارسی): [توضیح]

---

✨ **ترکیب پیشنهادی هوش مصنوعی (Best Connection):**
\`[یک جمله واحد نهایی و حرفه‌ای با استفاده از بهینه‌ترین ساختار گرامری (مانند FANBOYS، Subordinators، یا Transitions) متناسب با منطق متن]\`
(تعداد کلمات: [عدد] ✅)

---

💡 **نکات آموزشی انتخاب ایده:**
• [نکته آموزشی]
`;

// --- Safe Multi-part Reply ---
async function safeReply(ctx, text) {
    const sections = text.split('---');
    for (const section of sections) {
        if (!section.trim()) continue;
        try {
            await ctx.reply(section.trim(), { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.reply(section.trim());
        }
    }
}

// --- Commands ---
bot.start((ctx) => ctx.reply('خوش آمدید! متن SWT خود را بفرستید.'));

bot.command('credit_status', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /credit_status [ID]");
    try {
        const db = await getDB();
        const used = db.users?.[target]?.count || 0;
        const limit = db.users?.[target]?.limit ?? LIMIT;
        ctx.reply(`📊 وضعیت ${target}:\nاستفاده شده: ${used}\nسقف: ${limit}\nباقی‌مانده: ${limit - used}`);
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در دریافت اطلاعات.");
    }
});

bot.command('credit_add', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const parts = ctx.message.text.split(' ');
    const target = parts[1];
    const n = parseInt(parts[2]);
    if (!target || isNaN(n)) return ctx.reply("فرمت: /credit_add [ID] [تعداد]");

    try {
        const { db } = ensureUser(await getDB(), target);
        db.users[target].limit = (db.users[target].limit ?? LIMIT) + n;
        await saveDB(db);
        ctx.reply(`✅ ${n} اعتبار به کاربر ${target} اضافه شد.\nسقف جدید: ${db.users[target].limit}`);
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    }
});

// --- Text Handler ---
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    const userId = String(ctx.from.id);
    if (!isAdmin(userId) && !allowedUserIds.has(userId)) return ctx.reply("❌ دسترسی غیرمجاز.");

    try {
        const { db, migrated } = ensureUser(await getDB(), userId);
        if (migrated) await saveDB(db); // ذخیره migration فوری

        const userLimit = db.users[userId].limit ?? LIMIT;

        if (!isAdmin(userId) && db.users[userId].count >= userLimit) {
            return ctx.reply("❌ سهمیه تمام شده.");
        }

        await ctx.sendChatAction('typing');

        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4000,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: ctx.message.text }],
        });

        if (!isAdmin(userId)) {
            db.users[userId].count += 1;
            await saveDB(db);
        }

        await safeReply(ctx, response.content[0].text);
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطایی رخ داد.");
    }
});

// --- Server ---
const PORT = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.TELEGRAM_BOT_TOKEN}`;
bot.telegram.setWebhook(`${process.env.URL}${webhookPath}`);
app.use(bot.webhookCallback(webhookPath));
app.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));
