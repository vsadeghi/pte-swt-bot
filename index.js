require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// --- Admin List ---
const ADMIN_IDS = new Set(["97660313", "108265666", "6190801722"]);
const isAdmin = (id) => ADMIN_IDS.has(String(id));

// --- DB Logic (JSONBin.io) ---
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_ID}`;
const JSONBIN_HEADERS = {
    "Content-Type": "application/json",
    "X-Master-Key": process.env.JSONBIN_API_KEY
};

async function getDB() {
    try {
        const response = await fetch(JSONBIN_URL, { headers: JSONBIN_HEADERS });
        if (!response.ok) throw new Error(`DB Fetch Failed: ${response.statusText}`);
        const data = await response.json();
        
        // اطمینان از ساختار صحیح
        if (!data.record) return { allowedUserIds: [], users: {} };
        if (!data.record.allowedUserIds) data.record.allowedUserIds = [];
        if (!data.record.users) data.record.users = {};
        
        console.log('✅ DB loaded:', JSON.stringify(data.record, null, 2));
        return data.record;
    } catch (err) {
        console.error('❌ DB Load Error:', err);
        return { allowedUserIds: [], users: {} };
    }
}

async function saveDB(data) {
    try {
        console.log('💾 Saving DB:', JSON.stringify(data, null, 2));
        const response = await fetch(JSONBIN_URL, {
            method: 'PUT',
            headers: JSONBIN_HEADERS,
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            console.error("❌ DB Save Failed:", response.statusText);
            return false;
        }
        console.log('✅ DB saved successfully');
        return true;
    } catch (err) {
        console.error("❌ DB Save Error:", err);
        return false;
    }
}

const DEFAULT_LIMIT = 10;

function ensureUser(db, userId) {
    if (!db.users) db.users = {};
    let migrated = false;
    
    if (!db.users[userId]) {
        db.users[userId] = { count: 0, limit: DEFAULT_LIMIT };
        migrated = true;
        console.log(`🆕 New user created: ${userId}`);
    } else if (db.users[userId].limit === undefined) {
        db.users[userId].limit = DEFAULT_LIMIT;
        migrated = true;
        console.log(`🔧 User migrated: ${userId}`);
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

// دستور اضافه کردن کاربر به whitelist
bot.command('add_user', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /add_user [ID]");
    
    try {
        const db = await getDB();
        
        if (!db.allowedUserIds.includes(target)) {
            db.allowedUserIds.push(target);
            await saveDB(db);
            ctx.reply(`✅ کاربر ${target} به لیست مجاز اضافه شد.`);
        } else {
            ctx.reply(`⚠️ کاربر ${target} قبلاً در لیست مجاز است.`);
        }
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    }
});

// دستور حذف کاربر از whitelist
bot.command('remove_user', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /remove_user [ID]");
    
    try {
        const db = await getDB();
        
        const index = db.allowedUserIds.indexOf(target);
        if (index > -1) {
            db.allowedUserIds.splice(index, 1);
            await saveDB(db);
            ctx.reply(`✅ کاربر ${target} از لیست مجاز حذف شد.`);
        } else {
            ctx.reply(`⚠️ کاربر ${target} در لیست مجاز نیست.`);
        }
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    }
});

// دستور مشاهده وضعیت اعتبار
bot.command('credit_status', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /credit_status [ID]");
    
    try {
        const db = await getDB();
        const user = db.users?.[target];
        
        if (!user) {
            return ctx.reply(`❌ کاربر ${target} در دیتابیس یافت نشد.`);
        }
        
        const used = user.count || 0;
        const limit = user.limit ?? DEFAULT_LIMIT;
        const remaining = limit - used;
        
        ctx.reply(
            `📊 وضعیت کاربر ${target}:\n\n` +
            `• استفاده شده: ${used}\n` +
            `• سقف: ${limit}\n` +
            `• باقی‌مانده: ${remaining}`
        );
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در دریافت اطلاعات.");
    }
});

// دستور افزایش سقف اعتبار
bot.command('credit_add', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    
    const parts = ctx.message.text.split(' ');
    const target = parts[1];
    const n = parseInt(parts[2]);
    
    if (!target || isNaN(n)) return ctx.reply("فرمت: /credit_add [ID] [تعداد]");
    
    try {
        let db = await getDB();
        const result = ensureUser(db, target);
        db = result.db;
        
        db.users[target].limit = (db.users[target].limit ?? DEFAULT_LIMIT) + n;
        
        const saved = await saveDB(db);
        if (saved) {
            ctx.reply(
                `✅ ${n} اعتبار به کاربر ${target} اضافه شد.\n` +
                `سقف جدید: ${db.users[target].limit}`
            );
        } else {
            ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
        }
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    }
});

// دستور افزایش مصرف (count)
bot.command('credit_use', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    
    const parts = ctx.message.text.split(' ');
    const target = parts[1];
    const n = parseInt(parts[2]);
    
    if (!target || isNaN(n)) return ctx.reply("فرمت: /credit_use [ID] [تعداد]");
    
    try {
        let db = await getDB();
        const result = ensureUser(db, target);
        db = result.db;
        
        db.users[target].count = (db.users[target].count ?? 0) + n;
        
        const saved = await saveDB(db);
        if (saved) {
            ctx.reply(`✅ count کاربر ${target} به ${db.users[target].count} رسید.`);
        } else {
            ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
        }
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    }
});

// دستور ریست کردن اعتبار
bot.command('credit_reset', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("❌ فقط ادمین‌ها دسترسی دارند.");
    
    const target = ctx.message.text.split(' ')[1];
    if (!target) return ctx.reply("فرمت: /credit_reset [ID]");
    
    try {
        const db = await getDB();
        
        if (!db.users?.[target]) {
            return ctx.reply(`❌ کاربر ${target} در دیتابیس یافت نشد.`);
        }
        
        db.users[target] = { count: 0, limit: DEFAULT_LIMIT };
        
        const saved = await saveDB(db);
        if (saved) {
            ctx.reply(
                `✅ اعتبار کاربر ${target} ریست شد.\n` +
                `count: 0 | limit: ${DEFAULT_LIMIT}`
            );
        } else {
            ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
        }
    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ خطا در ذخیره اطلاعات.");
    }
});

// --- Text Handler ---
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    const userId = String(ctx.from.id);
    
    try {
        console.log(`📨 Message from user: ${userId}`);
        
        // بارگذاری دیتابیس
        let db = await getDB();
        
        // بررسی دسترسی
        const hasAccess = isAdmin(userId) || db.allowedUserIds.includes(userId);
        if (!hasAccess) {
            console.log(`❌ Unauthorized access attempt: ${userId}`);
            return ctx.reply("❌ دسترسی غیرمجاز. لطفاً با ادمین تماس بگیرید.");
        }
        
        // اطمینان از وجود کاربر در دیتابیس
        const result = ensureUser(db, userId);
        db = result.db;
        
        // ذخیره فوری اگر کاربر جدید است
        if (result.migrated) {
            console.log(`💾 Saving new user: ${userId}`);
            await saveDB(db);
        }
        
        const userLimit = db.users[userId].limit ?? DEFAULT_LIMIT;
        const userCount = db.users[userId].count ?? 0;
        
        console.log(`📊 User ${userId} - Count: ${userCount}, Limit: ${userLimit}`);
        
        // بررسی سهمیه (فقط برای غیر ادمین‌ها)
        if (!isAdmin(userId) && userCount >= userLimit) {
            console.log(`⛔ User ${userId} quota exceeded`);
            return ctx.reply(
                `❌ سهمیه شما تمام شده است.\n\n` +
                `استفاده شده: ${userCount}/${userLimit}\n` +
                `برای افزایش سهمیه با ادمین تماس بگیرید.`
            );
        }
        
        // ارسال typing action
        await ctx.sendChatAction('typing');
        
        console.log(`🤖 Calling Claude API for user ${userId}...`);
        
        // فراخوانی Claude API
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4000,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: ctx.message.text }],
        });
        
        console.log(`✅ Claude API response received for user ${userId}`);
        
        // افزایش count فقط برای غیر ادمین‌ها
        if (!isAdmin(userId)) {
            console.log(`📈 Incrementing count for user ${userId}: ${userCount} -> ${userCount + 1}`);
            db.users[userId].count = userCount + 1;
            
            const saved = await saveDB(db);
            if (saved) {
                console.log(`✅ Count saved successfully for user ${userId}`);
            } else {
                console.error(`❌ Failed to save count for user ${userId}`);
            }
        } else {
            console.log(`👑 Admin ${userId} - count not incremented`);
        }
        
        // ارسال پاسخ
        await safeReply(ctx, response.content[0].text);
        
    } catch (e) {
        console.error('❌ Error in text handler:', e);
        ctx.reply("⚠️ خطایی رخ داد. لطفاً دوباره تلاش کنید.");
    }
});

// --- Server ---
const PORT = process.env.PORT || 3000;
const webhookPath = `/bot${process.env.TELEGRAM_BOT_TOKEN}`;

bot.telegram.setWebhook(`${process.env.URL}${webhookPath}`);
app.use(bot.webhookCallback(webhookPath));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Bot running on port ${PORT}`);
    console.log(`📡 Webhook: ${process.env.URL}${webhookPath}`);
});
