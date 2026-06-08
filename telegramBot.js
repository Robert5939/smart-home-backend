/**
 * ============================================================
 *  Smart Home EMS — Interactive Telegram Bot
 * ============================================================
 */

const https   = require("https");
const Reading = require("./models/Reading");
const Command = require("./models/command");

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD = process.env.DASHBOARD_URL || "https://smart-home-energy-system.netlify.app";
const AI_KEY    = process.env.GROQ_API_KEY;

let lastUpdateId = 0;

// ============================================================
//  LOW-LEVEL TELEGRAM API
// ============================================================

function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${TOKEN}/${method}`,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(json),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end",  () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

async function sendMessage(chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return telegramRequest("sendMessage", body);
}

async function editMessage(chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  else          body.reply_markup = { inline_keyboard: [] };
  return telegramRequest("editMessageText", body);
}

async function answerCallback(id, text = "") {
  return telegramRequest("answerCallbackQuery", { callback_query_id: id, text });
}

async function getUpdates() {
  const res = await telegramRequest("getUpdates", { offset: lastUpdateId + 1, timeout: 2 });
  return res.result || [];
}

// ============================================================
//  DATA HELPERS
// ============================================================

async function getLatest() {
  return Reading.findOne().sort({ timestamp: -1 });
}

// Get today's aggregated stats using interval fields (reboot-safe)
async function getTodayStats() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const result = await Reading.aggregate([
    { $match: { timestamp: { $gte: since } } },
    {
      $group: {
        _id: null,
        dailyKwh:  { $sum: "$intervalEnergyKwh" },
        dailyCost: { $sum: "$intervalCostDen"   },
        lightKwh:  { $sum: { $cond: ["$lightOn",  { $ifNull: ["$intervalEnergyKwh", 0] }, 0] } },
        tvKwh:     { $sum: { $cond: ["$tvOn",     { $ifNull: ["$intervalEnergyKwh", 0] }, 0] } },
        fridgeKwh: { $sum: { $cond: ["$fridgeOn", { $ifNull: ["$intervalEnergyKwh", 0] }, 0] } },
        lightMins: { $sum: { $cond: ["$lightOn",  30, 0] } },
        tvMins:    { $sum: { $cond: ["$tvOn",     30, 0] } },
        fridgeMins:{ $sum: { $cond: ["$fridgeOn", 30, 0] } },
      }
    }
  ]);

  return result[0] || {
    dailyKwh: 0, dailyCost: 0,
    lightKwh: 0, tvKwh: 0, fridgeKwh: 0,
    lightMins: 0, tvMins: 0, fridgeMins: 0,
  };
}

async function getLast7DaysStats() {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  since.setHours(0, 0, 0, 0);

  const days = await Reading.aggregate([
    { $match: { timestamp: { $gte: since } } },
    {
      $group: {
        _id: {
          year:  { $year:  "$timestamp" },
          month: { $month: "$timestamp" },
          day:   { $dayOfMonth: "$timestamp" },
        },
        dailyKwh:  { $sum: "$intervalEnergyKwh" },
        dailyCost: { $sum: "$intervalCostDen"   },
        dateRef:   { $first: "$timestamp" },
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
  ]);

  if (!days.length) return null;

  let totalKwh = 0, totalCost = 0;
  const dailyBreakdown = days.map((d) => {
    totalKwh  += d.dailyKwh;
    totalCost += d.dailyCost;
    return {
      date: new Date(d.dateRef).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", timeZone: "Europe/Skopje"
      }),
      kwh:  Number(d.dailyKwh.toFixed(3)),
      cost: Number(d.dailyCost.toFixed(2)),
    };
  });

  return {
    totalKwh:    Number(totalKwh.toFixed(3)),
    totalCost:   Number(totalCost.toFixed(2)),
    dailyBreakdown,
    days: days.length,
  };
}

async function sendCommand(device, action) {
  await Command.deleteMany({ device, executed: false });
  await Command.create({ device, action });
  console.log(`[Bot] Command queued: ${device} → ${action}`);
}

function tariffLabel(tariff) { return tariff <= 5 ? "CHEAP 🟢" : "PEAK 🔴"; }
function pad(n) { return String(n ?? 0).padStart(2, "0"); }
function localTime() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/Skopje",
    day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ============================================================
//  GROQ AI TIPS
// ============================================================

async function getAITips(latest, today, week) {
  if (!AI_KEY) return "⚠️ AI tips unavailable — GROQ_API_KEY not set.";

  const prompt = `You are an AI energy advisor for a smart home in Macedonia.
Devices: Light (10W), TV (100W), Fridge (150W — must run 24/7, NEVER suggest turning it off).
Tariff: cheap (5 den/kWh) 13:00-15:00, 22:00-07:00, Sundays. Peak (10 den/kWh) otherwise.

Give exactly 3 short actionable tips. Use emojis. Under 20 words each. Use specific numbers.

TODAY's data:
- Energy used today: ${today.dailyKwh.toFixed(3)} kWh
- Cost today: ${today.dailyCost.toFixed(2)} den
- Tariff now: ${latest.tariff} den/kWh (${tariffLabel(latest.tariff)})
- TV today: ${today.tvMins} min, Light today: ${today.lightMins} min
${week ? `- 7-day total: ${week.totalKwh} kWh, ${week.totalCost} den` : ""}`;

  const body = JSON.stringify({
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 300,
  });

  return new Promise((resolve) => {
    const options = {
      hostname: "api.groq.com",
      path:     "/openai/v1/chat/completions",
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Authorization":  `Bearer ${AI_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 429) { resolve("⏳ Rate limit. Try again in 1 minute."); return; }
          if (res.statusCode !== 200) { resolve(`⚠️ AI error (${res.statusCode}).`); return; }
          resolve(parsed.choices?.[0]?.message?.content || "Could not generate tips.");
        } catch { resolve("Could not parse AI response."); }
      });
    });
    req.on("error", () => resolve("AI service unavailable."));
    req.write(body);
    req.end();
  });
}

// ============================================================
//  KEYBOARDS
// ============================================================

const MAIN_MENU = [
  [
    { text: "📊 Today's Summary", callback_data: "summary"  },
    { text: "🏠 Device Status",   callback_data: "devices"  },
  ],
  [
    { text: "⚡ Energy Stats",    callback_data: "energy"   },
    { text: "💰 Cost & Tariff",   callback_data: "cost"     },
  ],
  [
    { text: "🎮 Control Devices", callback_data: "controls" },
    { text: "🤖 AI Tips",         callback_data: "ai_tips"  },
  ],
  [
    { text: "📈 7-Day Report",    callback_data: "week"     },
    { text: "🔗 Dashboard",       callback_data: "dashboard"},
  ],
];

const BACK_BUTTON  = [[{ text: "⬅️ Back to Menu", callback_data: "menu" }]];
const REFRESH_BACK = [
  [{ text: "🔄 Refresh Tips",  callback_data: "ai_tips" }],
  [{ text: "⬅️ Back to Menu", callback_data: "menu"    }],
];

function controlKeyboard(latest) {
  return [
    [{
      text: latest?.lightOn ? "💡 Light: ON  → Turn OFF" : "💡 Light: OFF → Turn ON",
      callback_data: latest?.lightOn ? "cmd_light_off" : "cmd_light_on",
    }],
    [{
      text: latest?.tvOn ? "📺 TV: ON  → Turn OFF" : "📺 TV: OFF → Turn ON",
      callback_data: latest?.tvOn ? "cmd_tv_off" : "cmd_tv_on",
    }],
    [{ text: "🔄 Refresh", callback_data: "controls" }],
    ...BACK_BUTTON,
  ];
}

// ============================================================
//  RESPONSE BUILDERS — all use TODAY's interval-based stats
// ============================================================

async function buildSummary() {
  const [d, today] = await Promise.all([getLatest(), getTodayStats()]);
  if (!d) return ["No data available yet.", BACK_BUTTON];

  return [
`📊 <b>Today's Summary</b>

⚡ Energy today:  <b>${today.dailyKwh.toFixed(3)} kWh</b>
💰 Cost today:    <b>${today.dailyCost.toFixed(2)} den</b>
📡 Tariff now:    <b>${tariffLabel(d.tariff)}</b>
⏰ Time:          <b>${localTime()}</b>

🕐 <b>Runtime today:</b>
  💡 Light:   ${today.lightMins} min
  📺 TV:      ${today.tvMins} min
  ❄️ Fridge:  ${today.fridgeMins} min`,
    BACK_BUTTON
  ];
}

async function buildDevices() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];
  const icon = (on, fault = false) => fault ? "🔴 FAULT" : on ? "🟢 ON" : "⚪ OFF";

  return [
`🏠 <b>Device Status</b>

💡 Light:   ${icon(d.lightOn)}
📺 TV:      ${icon(d.tvOn)}
❄️ Fridge:  ${icon(d.fridgeOn, !d.fridgeOn)}

🔄 Last updated: ${localTime()}
📍 Motion: ${d.motionDetected ? "🟢 Detected" : "⚪ None"}`,
    [
      [{ text: "🔄 Refresh Status",  callback_data: "devices"  }],
      [{ text: "🎮 Control Devices", callback_data: "controls" }],
      ...BACK_BUTTON,
    ]
  ];
}

async function buildControls() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];
  const icon = (on) => on ? "🟢 ON" : "⚪ OFF";

  return [
`🎮 <b>Device Control</b>

💡 Light:   ${icon(d.lightOn)}
📺 TV:      ${icon(d.tvOn)}
❄️ Fridge:  ${icon(d.fridgeOn)} <i>(always on)</i>

Tap to toggle. Command reaches ESP32 in ~2 seconds.
⏰ ${localTime()}`,
    controlKeyboard(d)
  ];
}

async function buildEnergy() {
  const [d, today] = await Promise.all([getLatest(), getTodayStats()]);
  if (!d) return ["No data available yet.", BACK_BUTTON];

  const total = today.dailyKwh || 0.0001;
  const pL = Math.round((today.lightKwh  / total) * 100);
  const pT = Math.round((today.tvKwh     / total) * 100);
  const pF = Math.round((today.fridgeKwh / total) * 100);
  const bar = (p) => "█".repeat(Math.round(p/10)) + "░".repeat(10 - Math.round(p/10));

  return [
`⚡ <b>Energy Breakdown — Today</b>

💡 Light:   ${today.lightKwh.toFixed(4)} kWh  (${pL}%)
<code>${bar(pL)}</code>

📺 TV:      ${today.tvKwh.toFixed(4)} kWh  (${pT}%)
<code>${bar(pT)}</code>

❄️ Fridge:  ${today.fridgeKwh.toFixed(4)} kWh  (${pF}%)
<code>${bar(pF)}</code>

📦 Total today: <b>${today.dailyKwh.toFixed(4)} kWh</b>`,
    BACK_BUTTON
  ];
}

async function buildCost() {
  const [d, today] = await Promise.all([getLatest(), getTodayStats()]);
  if (!d) return ["No data available yet.", BACK_BUTTON];

  const cheap    = d.tariff <= 5;
  const cheapCost= today.dailyKwh * 5;
  const peakCost = today.dailyKwh * 10;
  const saving   = (peakCost - cheapCost).toFixed(2);

  return [
`💰 <b>Cost & Tariff — Today</b>

Current tariff: <b>${tariffLabel(d.tariff)} (${d.tariff} den/kWh)</b>
Cost today: <b>${today.dailyCost.toFixed(2)} den</b>

📊 <b>Tariff schedule:</b>
  🟢 Cheap (5 den):  13:00–15:00
  🟢 Cheap (5 den):  22:00–07:00
  🟢 Cheap (5 den):  Sundays all day
  🔴 Peak  (10 den): all other times

💡 Max saving if all at cheap rate: <b>${saving} den</b>`,
    BACK_BUTTON
  ];
}

async function buildAITips() {
  const [latest, today, week] = await Promise.all([
    getLatest(), getTodayStats(), getLast7DaysStats()
  ]);
  if (!latest) return ["No data available yet.", BACK_BUTTON];
  const tips = await getAITips(latest, today, week);

  return [
`🤖 <b>AI Energy Tips</b>
<i>Powered by Groq AI · Based on today's live data</i>

${tips}`,
    REFRESH_BACK
  ];
}

async function buildWeekReport() {
  const week = await getLast7DaysStats();
  if (!week) return ["Not enough data for a 7-day report yet.", BACK_BUTTON];

  let dailyLines = "";
  week.dailyBreakdown.forEach(d => {
    dailyLines += `${d.date}: ${d.kwh} kWh · ${d.cost} den\n`;
  });

  return [
`📈 <b>7-Day Report</b>

⚡ Total energy:  <b>${week.totalKwh} kWh</b>
💰 Total cost:    <b>${week.totalCost} den</b>

📅 <b>Daily breakdown:</b>
<code>${dailyLines}</code>
📊 <b>Daily averages:</b>
  ⚡ ${(week.totalKwh  / week.days).toFixed(3)} kWh/day
  💰 ${(week.totalCost / week.days).toFixed(2)} den/day`,
    BACK_BUTTON
  ];
}

function buildMainMenu() {
  return [
`🏠 <b>Smart Home EMS</b>
<i>Your energy management assistant</i>

What would you like to check?`,
    MAIN_MENU
  ];
}

// ============================================================
//  UPDATE DISPATCHER
// ============================================================

async function handleUpdate(update) {
  if (update.message) {
    const chatId = update.message.chat.id;
    await telegramRequest("deleteMessage", {
      chat_id: chatId, message_id: update.message.message_id,
    }).catch(() => {});
    const [msg, kb] = buildMainMenu();
    await sendMessage(chatId, msg, kb);
    return;
  }

  if (update.callback_query) {
    const query  = update.callback_query;
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const action = query.data;

    await answerCallback(query.id);

    // Device control commands
    if (action.startsWith("cmd_")) {
      const parts  = action.split("_");
      const device = parts[1];
      const cmd    = parts[2];
      await sendCommand(device, cmd);
      await new Promise(r => setTimeout(r, 2000));
      const [msg, kb] = await buildControls();
      await editMessage(chatId, msgId, msg, kb);
      return;
    }

    if (action === "dashboard") {
      await editMessage(chatId, msgId,
        `🔗 <b>Dashboard Link</b>\n\n<a href="${DASHBOARD}">${DASHBOARD}</a>`,
        BACK_BUTTON
      );
      return;
    }

    let result;
    switch (action) {
      case "menu":     result = buildMainMenu();   break;
      case "summary":  result = buildSummary();    break;
      case "devices":  result = buildDevices();    break;
      case "controls": result = buildControls();   break;
      case "energy":   result = buildEnergy();     break;
      case "cost":     result = buildCost();       break;
      case "ai_tips":  result = buildAITips();     break;
      case "week":     result = buildWeekReport(); break;
      default:         result = buildMainMenu();
    }

    const [msg, kb] = await result;
    await editMessage(chatId, msgId, msg, kb);
  }
}

// ============================================================
//  WEBHOOK
// ============================================================

async function setupWebhook(baseUrl) {
  const webhookUrl = `${baseUrl}/telegram-webhook`;
  const res = await telegramRequest("setWebhook", { url: webhookUrl });
  console.log("[Bot] Webhook set:", JSON.stringify(res));
}

module.exports = { handleUpdate, setupWebhook };