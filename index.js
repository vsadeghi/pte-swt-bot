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
        const response = await fetch(process.env.GOOGLE_SHEET_CSV_URL);
        const data = await response.text();
        const rows = data.split('\n');
        allowedUserIds = new Set(rows.map(row => row.trim()).filter(id => id !== ""));
    } catch (err) { console.error("Whitelist sync failed:", err); }
}
setInterval(syncWhitelist, 3600000);
syncWhitelist();

// --- DB Logic ---
async function getDB() {
    const response = await fetch(`https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}/latest`, { headers: { "X-Master-Key": process.env.JSONBIN_KEY } });
    const data = await response.json();
    return data.record || { users: {} };
}

async function saveDB(data) {
    await fetch(`https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}`, {
        method: 'PUT',
        headers: { "Content-Type": "application/json", "X-Master-Key": process.env.JSONBIN_KEY },
        body: JSON.stringify(data)
    });
}

function ensureUser(db, userId) {
    if (!db.users) db.users = {};
    if (!db.users[userId]) db.users[userId] = { count: 0 };
    return db;
}

// --- Prompt ---
const SYSTEM_PROMPT = `You are an expert PTE tutor. Analyze the student's SWT summary. 
IMPORTANT: Start the message with "📋" to ensure correct RTL text direction. Output in PERSIAN. Use Markdown.

RULES:
1. SWT must be EXACTLY ONE sentence.
2. If you must use English terms, enclose them in parentheses (e.g., (connection)) to help the interface render text correctly.
3. Use bullet points (•) for all lists.
4. For "بررسی دقیق کانکشن‌ها", provide detailed, pedagogical, and long explanations for each point.

Output Format:
📋 **خلاصه دانشجو:**
[متن]

📊 **تحلیل آماری:**
• تعداد کلمات: [عدد]
• محتوا: [امتیاز] از 5
• فرمت تک‌جمله‌ای: [امتیاز] از 5
• گرامر و کانکشن: [امتیاز] از 5

🔗 **بررسی دقیق کانکشن‌ها:**
• کانکشن‌های صحیح: [مورد]
• کانکشن‌های دارای ایراد:
  - (عبارت انگلیسی): [دلیل آموزشی مفصل و دقیق به فارسی] | پیشنهاد اصلاح: [عبارت اصلاح شده]

💡 **نکات کلیدی برای بهبود:**
• [نکته ۱]
• [نکته ۲]

✍️ **نسخه بازنویسی شده نهایی:**
[جمله اصلاح شده در یک سطر]`;

const LIMIT = 10;

// --- Helper for Long Messages ---
async function sendLongMessage(ctx, text) {
    const MAX_LENGTH = 4000;
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
        if (db.users[userId].count >= LIMIT) return ctx.reply("❌ سهمیه تمام شده.");
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 2000,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: ctx.message.text }],
        });
        db.users[userId].count += 1;
        await saveDB(db);
        await sendLongMessage(ctx, response.content[0].text);
    } catch (e) { ctx.reply("⚠️ خطایی رخ داد."); }
});

// --- Webhook ---
const PORT = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.TELEGRAM_BOT_TOKEN}`;
bot.telegram.setWebhook(`${process.env.URL}${webhookPath}`);
app.use(bot.webhookCallback(webhookPath));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running perfectly on port ${PORT}`);
});
