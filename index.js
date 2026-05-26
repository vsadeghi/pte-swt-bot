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
        console.log("Whitelist updated. Count:", allowedUserIds.size);
    } catch (err) { console.error("Whitelist sync failed:", err); }
}
setInterval(syncWhitelist, 300000);
syncWhitelist();

// --- DB Logic (Migrated to npoint.io for stability) ---
async function getDB() {
    try {
        const response = await fetch(`https://api.npoint.io/${process.env.JSONBIN_ID}`, {
            headers: { "Cache-Control": "no-cache" }
        });
        if (!response.ok) return { users: {} };
        const data = await response.json();
        return data || { users: {} };
    } catch (err) {
        console.error("DB Read Error:", err);
        return { users: {} };
    }
}

async function saveDB(data) {
    try {
        await fetch(`https://api.npoint.io/${process.env.JSONBIN_ID}`, {
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
    } catch (err) {
        console.error("DB Save Error:", err);
    }
}

function ensureUser(db, userId) {
    if (!db.users) db.users = {};
    if (!db.users[userId]) db.users[userId] = { count: 0 };
    return db;
}

// --- Prompt (Exactly as you provided) ---
const SYSTEM_PROMPT = `You are an expert PTE tutor. Analyze the student's SWT (Summarize Written Text). 
IMPORTANT: Always start the message with "📋" to fix RTL direction. Use Markdown.
⚠️ IMPORTANT PTE RULE: If the word count is more than 75 words, the score is automatically ZERO.

RULES:
1. SWT must be EXACTLY ONE sentence.
2. For any English phrase or correction, put it on a NEW LINE.
3. Use bullet points (•) for all lists.
4. Be concise and finish the response completely.

Output Format:
📋 **تحلیل تخصصی SWT:**

📊 **تحلیل آماری:**
• تعداد کلمات: [عدد]
• محتوا: [امتیاز] از 5
• فرمت: [امتیاز] از 5

🔗 **تحلیل و کالبدشکافی کانکشن‌های دانشجو:**
• کانکشن‌های صحیح: [مورد]
• کانکشن‌های دارای ایراد:
  - تحلیل ایراد (به فارسی): [دلیل آموزشی]
  - عبارت اصلی دانشجو: \`[عبارت]\`
  - پیشنهاد اصلاح: \`[اصلاح شده]\`

💡 **نکات کلیدی برای بهبود متن دانشجو:**
• [نکته]

✍️ **نسخه اصلاح شده جمله دانشجو:**
\`[نسخه نهایی]\`

🎯 **جملات کلیدی پیشنهادی (AI Selection):**
• جملات منتخب: 
  \`[۱]\` \`[۲]\` \`[۳]\`
• دلیل اهمیت (فارسی): [توضیح]

✨ **ترکیب پیشنهادی هوش مصنوعی (Best Connection):**
\`[یک جمله واحد نهایی]\`

💡 **نکات آموزشی انتخاب ایده:**
• [نکته آموزشی]
`;

const LIMIT = 10;

// --- Helper for Long Messages ---
async function sendLongMessage(ctx, text) {
    const MAX_LENGTH = 3800;
    if (text.length <= MAX_LENGTH) {
        return ctx.reply(text, { parse_mode: 'Markdown' });
    }
    const chunks = text.match(new RegExp('.{1,' + MAX_LENGTH + '}(\\s|$)', 'gs'));
    for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: 'Markdown' });
    }
}

// --- Admin Commands ---
bot.command('credit_status', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const targetUserId = ctx.message.text.split(/\s+/)[1];
    if (!targetUserId) return ctx.reply("فرمت صحیح: /credit_status <userId>");
    const db = await getDB();
    const used = db.users?.[targetUserId]?.count ?? 0;
    ctx.reply(`ℹ️ وضعیت کاربر\nUser: ${targetUserId}\nUsed: ${used}\nLeft: ${Math.max(0, LIMIT - used)}\nLimit: ${LIMIT}`);
});

bot.command('credit_reset', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const targetUserId = ctx.message.text.split(/\s+/)[1];
    if (!targetUserId) return ctx.reply("فرمت صحیح: /credit_reset <userId>");
    const db = ensureUser(await getDB(), targetUserId);
    db.users[targetUserId].count = 0;
    await saveDB(db);
    ctx.reply(`✅ ریست شد\nUser: ${targetUserId}\ncount → 0`);
});

bot.command('credit_add', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const parts = ctx.message.text.split(/\s+/);
    const targetUserId = parts[1];
    const n = Math.max(0, parseInt(parts[2], 10) || 0);
    if (!targetUserId || !parts[2]) return ctx.reply("فرمت صحیح: /credit_add <userId> <n>");
    const db = ensureUser(await getDB(), targetUserId);
    const before = Number(db.users[targetUserId].count || 0);
    db.users[targetUserId].count = Math.max(0, before - n);
    await saveDB(db);
    ctx.reply(`✅ شارژ انجام شد\nUser: ${targetUserId}\nUsed: ${before} → ${db.users[targetUserId].count}\n(+${n} credit added)`);
});

// --- Text Handler ---
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    const userId = String(ctx.from.id);
    
    if (!isAdmin(userId) && !allowedUserIds.has(userId)) return ctx.reply("❌ دسترسی غیرمجاز.");
    
    try {
        let db = ensureUser(await getDB(), userId);
        
        if (!isAdmin(userId) && db.users[userId].count >= LIMIT) {
            return ctx.reply("❌ سهمیه تمام شده.");
        }

                const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6", // دقیقاً مطابق عکسی که فرستادید
            max_tokens: 4000,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: ctx.message.text }],
        });


        if (!isAdmin(userId)) {
            db.users[userId].count += 1;
            await saveDB(db);
        }

        await sendLongMessage(ctx, response.content[0].text);
    } catch (e) { 
        console.error(e);
        ctx.reply("⚠️ خطایی در ارتباط با هوش مصنوعی رخ داد."); 
    }
});

// --- Webhook ---
const PORT = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.TELEGRAM_BOT_TOKEN}`;
bot.telegram.setWebhook(`${process.env.URL}${webhookPath}`);
app.use(bot.webhookCallback(webhookPath));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
