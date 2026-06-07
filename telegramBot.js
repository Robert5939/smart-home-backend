/**
 * ============================================================
 *  Smart Home EMS — Interactive Telegram Bot
 * ============================================================
 */

const https   = require("https");
const Reading = require("./models/Reading");
const Command = require("./models/Command");

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
    const json    = JSON.stringify(body);
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
      res.on("end",  () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
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

async function answerCallback(callbackQueryId, text = "") {
  return telegramRequest("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
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

async function getYesterday() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const end = new Date(yesterday);
  end.setHours(23, 59, 59, 999);
  return Reading.findOne({ timestamp: { $gte: yesterday, $lte: end } }).sort({ timestamp: -1 });
}

async function getLast7DaysStats() {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  since.setHours(0, 0, 0, 0);

  const first = await Reading.findOne({ timestamp: { $gte: since } }).sort({ timestamp:  1 });
  const last  = await Reading.findOne({ timestamp: { $gte: since } }).sort({ timestamp: -1 });
  if (!first || !last || first._id.equals(last._id)) return null;

  const days = await Reading.aggregate([
    { $match: { timestamp: { $gte: since } } },
    {
      $group: {
        _id: {
          year:  { $year:  "$timestamp" },
          month: { $month: "$timestamp" },
          day:   { $dayOfMonth: "$timestamp" },
        },
        minEnergy: { $min: "$totalEnergyKwh" },
        maxEnergy: { $max: "$totalEnergyKwh" },
        minCost:   { $min: "$costDen" },
        maxCost:   { $max: "$costDen" },
        dateRef:   { $first: "$timestamp" },
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
  ]);

  let totalKwh = 0, totalCost = 0;
  const dailyBreakdown = days.map((d) => {
    const kwh  = Math.max(0, d.maxEnergy - d.minEnergy);
    const cost = Math.max(0, d.maxCost   - d.minCost);
    totalKwh  += kwh;
    totalCost += cost;
    return {
      date: new Date(d.dateRef).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", timeZone: "Europe/Skopje"
      }),
      kwh:  Number(kwh.toFixed(3)),
      cost: Number(cost.toFixed(2)),
    };
  });

  return {
    totalKwh:    Number(totalKwh.toFixed(3)),
    totalCost:   Number(totalCost.toFixed(2)),
    lightHours:  Number(((last.runtimeLightMin  - first.runtimeLightMin)  / 60).toFixed(1)),
    tvHours:     Number(((last.runtimeTvMin     - first.runtimeTvMin)     / 60).toFixed(1)),
    fridgeHours: Number(((last.runtimeFridgeMin - first.runtimeFridgeMin) / 60).toFixed(1)),
    dailyBreakdown,
    days: dailyBreakdown.length,
  };
}

// ── Send command to ESP32 via DB ──────────────────────────
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

async function getAITips(latest, yesterday, week) {
  if (!AI_KEY) return "⚠️ AI tips unavailable — GROQ_API_KEY not set.";

  const prompt = `You are an AI energy advisor for a smart home in Macedonia.
The system has: Light (10W), TV (100W), Fridge (150W, must run 24/7 — NEVER suggest turning it off).
Tariff: cheap (5 den/kWh) 13:00-15:00, 22:00-07:00, Sundays. Peak (10 den/kWh) otherwise.

Give exactly 3 short actionable tips. Use emojis. Under 20 words each. Use specific numbers.

Data:
- Energy: ${latest.totalEnergyKwh} kWh, Cost: ${latest.costDen} den
- Tariff: ${latest.tariff} den/kWh (${tariffLabel(latest.tariff)})
- TV: ${latest.runtimeTvMin}min, Light: ${latest.runtimeLightMin}min, Fridge: ${latest.runtimeFridgeMin}min
${yesterday ? `- Yesterday TV: ${yesterday.runtimeTvMin}min, Light: ${yesterday.runtimeLightMin}min` : ""}
${week ? `- 7d: ${week.totalKwh}kWh, ${week.totalCost}den, TV avg: ${(week.tvHours/week.days).toFixed(1)}h/day` : ""}`;

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
          console.log("[Groq] Status:", res.statusCode);
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
    { text: "📊 Today's Summary", callback_data: "summary" },
    { text: "🏠 Device Status",   callback_data: "devices" },
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

// Device control keyboard — shows current state
function controlKeyboard(latest) {
  const lightOn  = latest?.lightOn;
  const tvOn     = latest?.tvOn;
  return [
    [
      { text: lightOn  ? "💡 Light: ON  → Turn OFF" : "💡 Light: OFF → Turn ON",
        callback_data: lightOn ? "cmd_light_off" : "cmd_light_on" },
    ],
    [
      { text: tvOn ? "📺 TV: ON  → Turn OFF" : "📺 TV: OFF → Turn ON",
        callback_data: tvOn ? "cmd_tv_off" : "cmd_tv_on" },
    ],
    [{ text: "🔄 Refresh Status", callback_data: "controls" }],
    ...BACK_BUTTON,
  ];
}

// ============================================================
//  RESPONSE BUILDERS
// ============================================================

async function buildSummary() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];
  return [
`📊 <b>Today's Summary</b>

⚡ Total energy:  <b>${d.totalEnergyKwh.toFixed(3)} kWh</b>
💰 Total cost:    <b>${d.costDen.toFixed(2)} den</b>
📡 Tariff:        <b>${tariffLabel(d.tariff)}</b>
⏰ Current time:  <b>${localTime()}</b>

🕐 <b>Device runtimes:</b>
  💡 Light:   ${d.runtimeLightMin} min
  📺 TV:      ${d.runtimeTvMin} min
  ❄️ Fridge:  ${d.runtimeFridgeMin} min`,
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
      [{ text: "🔄 Refresh Status", callback_data: "devices" }],
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

Tap a button to toggle a device.
Command delivered to ESP32 within 5 seconds.

⏰ ${localTime()}`,
    controlKeyboard(d)
  ];
}

async function buildEnergy() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];
  const total = d.totalEnergyKwh;
  const pL = total > 0 ? ((d.energyLightKwh  / total) * 100).toFixed(0) : 0;
  const pT = total > 0 ? ((d.energyTvKwh     / total) * 100).toFixed(0) : 0;
  const pF = total > 0 ? ((d.energyFridgeKwh / total) * 100).toFixed(0) : 0;
  const bar = (p) => "█".repeat(Math.round(p/10)) + "░".repeat(10 - Math.round(p/10));
  return [
`⚡ <b>Energy Breakdown</b>

💡 Light:   ${d.energyLightKwh.toFixed(4)} kWh  (${pL}%)
<code>${bar(pL)}</code>

📺 TV:      ${d.energyTvKwh.toFixed(4)} kWh  (${pT}%)
<code>${bar(pT)}</code>

❄️ Fridge:  ${d.energyFridgeKwh.toFixed(4)} kWh  (${pF}%)
<code>${bar(pF)}</code>

📦 Total:   <b>${total.toFixed(4)} kWh</b>`,
    BACK_BUTTON
  ];
}

async function buildCost() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];
  const cheapCost = d.totalEnergyKwh * 5;
  const peakCost  = d.totalEnergyKwh * 10;
  const saving    = (peakCost - cheapCost).toFixed(2);
  return [
`💰 <b>Cost & Tariff</b>

Current tariff: <b>${tariffLabel(d.tariff)} (${d.tariff} den/kWh)</b>
Total cost so far: <b>${d.costDen.toFixed(2)} den</b>

📊 <b>Tariff schedule:</b>
  🟢 Cheap (5 den):  13:00–15:00
  🟢 Cheap (5 den):  22:00–07:00
  🟢 Cheap (5 den):  Sundays all day
  🔴 Peak  (10 den): all other times

💡 If all energy at cheap rate: <b>${cheapCost.toFixed(2)} den</b>
   Potential saving: <b>${saving} den</b>`,
    BACK_BUTTON
  ];
}

async function buildAITips() {
  const [latest, yesterday, week] = await Promise.all([getLatest(), getYesterday(), getLast7DaysStats()]);
  if (!latest) return ["No data available yet.", BACK_BUTTON];
  const tips = await getAITips(latest, yesterday, week);
  return [
`🤖 <b>AI Energy Tips</b>
<i>Powered by Groq AI · Based on your live data</i>

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
  💰 ${(week.totalCost / week.days).toFixed(2)} den/day

🕐 <b>Device usage (7 days):</b>
  💡 Light:   ${week.lightHours}h
  📺 TV:      ${week.tvHours}h
  ❄️ Fridge:  ${week.fridgeHours}h`,
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
  // Text message — send fresh menu
  if (update.message) {
    const chatId = update.message.chat.id;
    await telegramRequest("deleteMessage", {
      chat_id: chatId, message_id: update.message.message_id,
    }).catch(() => {});
    const [msg, kb] = buildMainMenu();
    await sendMessage(chatId, msg, kb);
    return;
  }

  // Button tap
  if (update.callback_query) {
    const query  = update.callback_query;
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const action = query.data;

    await answerCallback(query.id);

    // ── Device control commands ──────────────────────────
    if (action.startsWith("cmd_")) {
      const parts  = action.split("_");  // ["cmd", "light", "on"]
      const device = parts[1];           // "light" or "tv"
      const cmd    = parts[2];           // "on" or "off"

      await sendCommand(device, cmd);

      // Show confirmation then updated controls
      await answerCallback(query.id, `${device} turning ${cmd}...`);

      // Wait 2 seconds for ESP32 to pick up command, then refresh
      await new Promise(r => setTimeout(r, 2000));
      const [msg, kb] = await buildControls();
      await editMessage(chatId, msgId, msg, kb);
      return;
    }

    // ── Dashboard link ────────────────────────────────────
    if (action === "dashboard") {
      await editMessage(chatId, msgId,
        `🔗 <b>Dashboard Link</b>\n\n<a href="${DASHBOARD}">${DASHBOARD}</a>`,
        BACK_BUTTON
      );
      return;
    }

    // ── Regular menu actions ──────────────────────────────
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
//  WEBHOOK SETUP
// ============================================================

async function setupWebhook(baseUrl) {
  const webhookUrl = `${baseUrl}/telegram-webhook`;
  const res = await telegramRequest("setWebhook", { url: webhookUrl });
  console.log("[Bot] Webhook set:", JSON.stringify(res));
}

module.exports = { handleUpdate, setupWebhook };