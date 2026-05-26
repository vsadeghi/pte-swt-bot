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
• تعداد کلماتعدد] کلمه
• [در صورت بالای ۷۵ کلمه: ⚠️ هشدار بحرانی: بیش از ۷۵ کلمه = نمره صفر خودکار!]
• محتوا: [امتیاز] از 5
• فرمت: [امتیاز] از 5

---

🔗 **تحلیل و کالبدشکافی کانکشن‌های دانشجو:**

• **کانکشن‌های صحیح:**
  - [توضیح استفاده درست از کانکتورها و منطق ا
