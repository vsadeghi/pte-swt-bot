require('dotenv').config();

const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000);

console.log("Token Loaded:", process.env.TELEGRAM_BOT_TOKEN ? "YES" : "NO");

const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

// اتصال به Claude
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ------------------- Admin -------------------
const ADMIN_IDS = new Set([
  "97660313",
  "108265666",
  "6190801722"
]);
const isAdmin = (id) => ADMIN_IDS.has(String(id));

// ------------------- Whitelist -------------------
let allowedUserIds = new Set();

async function syncWhitelist() {
  try {
    const response = await fetch(process.env.GOOGLE_SHEET_CSV_URL);
    const data = await response.text();
    const rows = data.split('\n');
    allowedUserIds = new Set(
      rows.map(row => row.trim()).filter(id => id !== "")
    );
    console.log("Whitelist updated. Allowed users:", allowedUserIds.size);
  } catch (err) {
    console.error("Whitelist sync failed:", err);
  }
}
setInterval(syncWhitelist, 3600000);
syncWhitelist();

// ------------------- JSONbin DB -------------------
async function getDB() {
  const response = await fetch(`https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}/latest`, {
    headers: { "X-Master-Key": process.env.JSONBIN_KEY }
  });
  const data = await response.json();
  return data.record || { users: {} };
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

function ensureUser(db, userId) {
  if (!db.users) db.users = {};
  if (!db.users[userId]) db.users[userId] = { count: 0 };
  if (typeof db.users[userId].count !== 'number') {
    db.users[userId].count = Number(db.users[userId].count || 0);
  }
  return db;
}

// ------------------- Prompt -------------------
const SYSTEM_PROMPT = `
You are an expert PTE tutor. Analyze the student's SWT summary. 
IMPORTANT: Always output in PERSIAN. 

RULES:
1. SWT must be EXACTLY ONE sentence. NEVER suggest splitting it.
2. If readability is low, use semicolons (;) or commas (,) or relative clauses.
3. Keep the layout clean for Telegram. Avoid complex Markdown tables.

Output Format:
- خلاصه دانشجو: [متن]
- تعداد کلمات: [عدد]

--- ارزیابی ---
- محتوا: [امتیاز] از 5
- فرمت (تک‌جمله‌ای): [امتیاز] از 5
- گرامر و کانکشن: [امتیاز] از 5

--- بررسی کانکشن‌ها ---
1. کانکشن‌های درست: [لیست]
2. کانکشن‌های دارای ایراد:
- (عبارت مورد نظر): [دلیل ایراد به فارسی] | پیشنهاد اصلاح: [عبارت اصلاح شده]

--- نکات کلیدی برای بهبود (فقط موارد گرامری و محتوایی) ---
1. [نکته ۱ - بدون توصیه به شکستن جمله]
2. [نکته ۲]
3. [نکته ۳]

--- نسخه بازنویسی شده نهایی ---
[یک جمله کامل و حرفه‌ای که محتوای دانشجو را در یک جمله بهبود داده است]
`;


// ------------------- Limits -------------------
const LIMIT = 10;

// ------------------- Admin Commands -------------------
bot.command('credit_status', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const targetUserId = parts[1];
  if (!targetUserId) return ctx.reply("فرمت صحیح: /credit_status <userId>");

  try {
    const db = await getDB();
    const used = db.users?.[String(targetUserId)]?.count ?? 0;
    const left = Math.max(0, LIMIT - used);

    return ctx.reply(
      `ℹ️ وضعیت کاربر\nUser: ${targetUserId}\nUsed: ${used}\nLeft: ${left}\nLimit: ${LIMIT}`
    );
  } catch (err) {
    console.error(err);
    return ctx.reply("❌ خطا در دریافت وضعیت (JSONBin).");
  }
});

bot.command('credit_reset', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const targetUserId = parts[1];
  if (!targetUserId) return ctx.reply("فرمت صحیح: /credit_reset <userId>");

  try {
    const db = ensureUser(await getDB(), String(targetUserId));
    db.users[String(targetUserId)].count = 0;
    await saveDB(db);

    return ctx.reply(`✅ ریست شد\nUser: ${targetUserId}\ncount → 0\nLimit: ${LIMIT}`);
  } catch (err) {
    console.error(err);
    return ctx.reply("❌ خطا در ریست (JSONBin).");
  }
});

bot.command('credit_add', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const targetUserId = parts[1];
  const nRaw = parts[2];

  if (!targetUserId || !nRaw) return ctx.reply("فرمت صحیح: /credit_add <userId> <n>");

  const n = Math.max(0, parseInt(nRaw, 10) || 0);

  try {
    const db = ensureUser(await getDB(), String(targetUserId));
    const before = Number(db.users[String(targetUserId)].count || 0);

    // credit_add یعنی مصرفی را کم می‌کنیم (اعتبار اضافه می‌شود)
    db.users[String(targetUserId)].count = Math.max(0, before - n);

    await saveDB(db);
    const after = db.users[String(targetUserId)].count;

    return ctx.reply(`✅ شارژ انجام شد\nUser: ${targetUserId}\nUsed: ${before} → ${after}\n(+${n} credit)`);
  } catch (err) {
    console.error(err);
    return ctx.reply("❌ خطا در شارژ (JSONBin).");
  }
});

// ------------------- Main text handler -------------------
bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  const userText = ctx.message.text || "";

  // اگر پیام کامند بود، کاری نکن (Telegraf command handlers بالا اجرا می‌شوند)
  if (userText.trim().startsWith('/')) return;

  // ۱) چک کردن لیست سفید (ادمین‌ها bypass)
  if (!isAdmin(userId) && !allowedUserIds.has(userId)) {
    return ctx.reply(`❌ دسترسی غیرمجاز. آیدی تلگرام شما: ${userId} در لیست دانش‌آموزان ثبت نشده است.`);
  }

  try {
    let db = ensureUser(await getDB(), userId);

    if (db.users[userId].count >= LIMIT) {
      return ctx.reply(`❌ متأسفم، سهمیه ${LIMIT} تمرین شما به پایان رسیده است.`);
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6", // دست نخورده
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    });

    db.users[userId].count += 1;
    await saveDB(db);

    return ctx.reply(response.content[0].text);

  } catch (error) {
    console.error(error);
    return ctx.reply("⚠️ خطایی در پردازش رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// حذف کنید: bot.launch(); 

// به جایش از این استفاده کنید:
const port = process.env.PORT || 3000;
bot.telegram.setWebhook(`${process.env.URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`);
app.use(bot.webhookCallback(`/bot${process.env.TELEGRAM_BOT_TOKEN}`));

app.listen(port, () => {
  console.log(`Bot is running on port ${port}`);
});

// برای جلوگیری از کرش کردن در سرورهای ابری
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
