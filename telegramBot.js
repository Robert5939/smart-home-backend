/**
 * ============================================================
 *  Smart Home EMS — Interactive Telegram Bot
 *
 *  Features:
 *   - Responds to commands and inline button taps
 *   - Fetches live data from MongoDB for every response
 *   - Uses Claude API for AI-generated tips
 *   - Polls Telegram for updates every 3 seconds
 *
 *  Required .env:
 *    TELEGRAM_TOKEN=...
 *    TELEGRAM_CHAT_ID=...
 *    ANTHROPIC_API_KEY=...
 *    DASHBOARD_URL=...
 * ============================================================
 */

const https    = require("https");
const Reading  = require("./models/Reading");

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD = process.env.DASHBOARD_URL || "https://your-dashboard.netlify.app";
const AI_KEY = process.env.GEMINI_API_KEY;

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

// Send a message with optional inline keyboard
async function sendMessage(chatId, text, keyboard = null) {
  const body = {
    chat_id:    chatId,
    text:       text,
    parse_mode: "HTML",
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return telegramRequest("sendMessage", body);
}

// Edit an existing message (for button responses)
async function editMessage(chatId, messageId, text, keyboard = null) {
  const body = {
    chat_id:    chatId,
    message_id: messageId,
    text:       text,
    parse_mode: "HTML",
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  else          body.reply_markup = { inline_keyboard: [] };
  return telegramRequest("editMessageText", body);
}

// Answer a callback query (removes loading spinner on button tap)
async function answerCallback(callbackQueryId, text = "") {
  return telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

// Poll for new messages/button taps
async function getUpdates() {
  const res = await telegramRequest("getUpdates", {
    offset:  lastUpdateId + 1,
    timeout: 2,
  });
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
  return Reading.findOne({
    timestamp: { $gte: yesterday, $lte: end }
  }).sort({ timestamp: -1 });
}

async function getLast7DaysStats() {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const readings = await Reading.find({ timestamp: { $gte: since } })
    .sort({ timestamp: 1 });
  if (!readings.length) return null;
  const first = readings[0];
  const last  = readings[readings.length - 1];
  return {
    totalKwh:  Number((last.totalEnergyKwh  - first.totalEnergyKwh).toFixed(3)),
    totalCost: Number((last.costDen          - first.costDen).toFixed(2)),
    lightHours:  Number(((last.runtimeLightMin  - first.runtimeLightMin)  / 60).toFixed(1)),
    tvHours:     Number(((last.runtimeTvMin     - first.runtimeTvMin)     / 60).toFixed(1)),
    fridgeHours: Number(((last.runtimeFridgeMin - first.runtimeFridgeMin) / 60).toFixed(1)),
  };
}

function tariffLabel(tariff) {
  return tariff <= 5 ? "CHEAP 🟢" : "PEAK 🔴";
}

function pad(n) {
  return String(n ?? 0).padStart(2, "0");
}

function localTime() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/Skopje",
    day:    "2-digit",
    month:  "short",
    hour:   "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ============================================================
//  CLAUDE AI TIPS
// ============================================================
async function getAITips(latest, yesterday, week) {

  if (!AI_KEY) {
    return "AI tips unavailable — GEMINI_API_KEY not set.";
  }

  const prompt = `
You are an AI energy advisor for a smart home system.

Give exactly 3 short practical energy-saving tips.

Use emojis.
Each tip must be under 20 words.

Current data:
- Total energy: ${latest.totalEnergyKwh} kWh
- Total cost: ${latest.costDen} den
- Tariff: ${latest.tariff} den/kWh
- TV runtime: ${latest.runtimeTvMin} min
- Light runtime: ${latest.runtimeLightMin} min
- Fridge runtime: ${latest.runtimeFridgeMin} min

7-day data:
${week ? `${week.totalKwh} kWh and ${week.totalCost} den` : "Unavailable"}
`;

  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ]
  });

  return new Promise((resolve) => {

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${AI_KEY}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {

      let data = "";

      res.on("data", chunk => data += chunk);

      res.on("end", () => {

        try {

          const parsed = JSON.parse(data);

          const text =
            parsed.candidates?.[0]?.content?.parts?.[0]?.text ||
            "Could not generate AI tips.";

          resolve(text);

        } catch {

          resolve("Could not parse Gemini response.");

        }

      });

    });

    req.on("error", () => {
      resolve("Gemini AI unavailable.");
    });

    req.write(body);
    req.end();

  });
}
// ============================================================
//  KEYBOARDS
// ============================================================

const MAIN_MENU = [
  [
    { text: "📊 Today's Summary",  callback_data: "summary"  },
    { text: "🏠 Device Status",    callback_data: "devices"  },
  ],
  [
    { text: "⚡ Energy Stats",     callback_data: "energy"   },
    { text: "💰 Cost & Tariff",    callback_data: "cost"     },
  ],
  [
    { text: "🤖 AI Tips",          callback_data: "ai_tips"  },
    { text: "📈 7-Day Report",     callback_data: "week"     },
  ],
  [
    { text: "🔗 Open Dashboard",   callback_data: "dashboard" },
  ],
];

const BACK_BUTTON = [[{ text: "⬅️ Back to Menu", callback_data: "menu" }]];

const REFRESH_BACK = [
  [{ text: "🔄 Refresh", callback_data: "ai_tips" }],
  [{ text: "⬅️ Back to Menu", callback_data: "menu" }],
];

// ============================================================
//  RESPONSE BUILDERS
// ============================================================

async function buildSummary() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];

  const text =
`📊 <b>Today's Summary</b>

⚡ Total energy:  <b>${d.totalEnergyKwh.toFixed(3)} kWh</b>
💰 Total cost:    <b>${d.costDen.toFixed(2)} den</b>
📡 Tariff:        <b>${tariffLabel(d.tariff)}</b>
⏰ Current time:  <b>${localTime()}</b>

🕐 <b>Device runtimes:</b>
  💡 Light:   ${d.runtimeLightMin} min
  📺 TV:      ${d.runtimeTvMin} min
  ❄️ Fridge:  ${d.runtimeFridgeMin} min`;

  return [text, BACK_BUTTON];
}

async function buildDevices() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];

  const icon = (on, fault = false) =>
    fault ? "🔴 FAULT" : on ? "🟢 ON" : "⚪ OFF";

  const text =
`🏠 <b>Device Status</b>

💡 Light:   ${icon(d.lightOn)}
📺 TV:      ${icon(d.tvOn)}
❄️ Fridge:  ${icon(d.fridgeOn, !d.fridgeOn)}

🔄 Last updated: ${localTime()}
📍 Motion: ${d.motionDetected ? "🟢 Detected" : "⚪ None"}`;

  const kb = [
    [{ text: "🔄 Refresh Status", callback_data: "devices" }],
    ...BACK_BUTTON,
  ];

  return [text, kb];
}

async function buildEnergy() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];

  const total = d.totalEnergyKwh;
  const pctLight  = total > 0 ? ((d.energyLightKwh  / total) * 100).toFixed(0) : 0;
  const pctTV     = total > 0 ? ((d.energyTvKwh     / total) * 100).toFixed(0) : 0;
  const pctFridge = total > 0 ? ((d.energyFridgeKwh / total) * 100).toFixed(0) : 0;

  const bar = (pct) => "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

  const text =
`⚡ <b>Energy Breakdown</b>

💡 Light:   ${d.energyLightKwh.toFixed(4)} kWh  (${pctLight}%)
<code>${bar(pctLight)}</code>

📺 TV:      ${d.energyTvKwh.toFixed(4)} kWh  (${pctTV}%)
<code>${bar(pctTV)}</code>

❄️ Fridge:  ${d.energyFridgeKwh.toFixed(4)} kWh  (${pctFridge}%)
<code>${bar(pctFridge)}</code>

📦 Total:   <b>${total.toFixed(4)} kWh</b>`;

  return [text, BACK_BUTTON];
}

async function buildCost() {
  const d = await getLatest();
  if (!d) return ["No data available yet.", BACK_BUTTON];

  const cheap     = d.tariff <= 5;
  const cheapCost = d.totalEnergyKwh * 5;
  const peakCost  = d.totalEnergyKwh * 10;
  const saving    = (peakCost - cheapCost).toFixed(2);

  const text =
`💰 <b>Cost & Tariff</b>

Current tariff: <b>${tariffLabel(d.tariff)} (${d.tariff} den/kWh)</b>
Total cost so far: <b>${d.costDen.toFixed(2)} den</b>

📊 <b>Tariff schedule:</b>
  🟢 Cheap (5 den):  13:00–15:00
  🟢 Cheap (5 den):  22:00–07:00
  🟢 Cheap (5 den):  Sundays all day
  🔴 Peak  (10 den): all other times

💡 Shifting all usage to cheap hours
   would save <b>${saving} den</b> total so far.`;

  return [text, BACK_BUTTON];
}

async function buildAITips() {
  const [latest, yesterday, week] = await Promise.all([
    getLatest(),
    getYesterday(),
    getLast7DaysStats(),
  ]);

  if (!latest) return ["No data available yet.", BACK_BUTTON];

  const tips = await getAITips(latest, yesterday, week);

  const text =
`🤖 <b>AI Energy Tips</b>
<i>Powered by Claude AI · Based on your live data</i>

${tips}`;

  return [text, REFRESH_BACK];
}

async function buildWeekReport() {
  const week = await getLast7DaysStats();
  if (!week) return ["Not enough data for a 7-day report yet.", BACK_BUTTON];

  const text =
`📈 <b>7-Day Report</b>

⚡ Total energy:  <b>${week.totalKwh} kWh</b>
💰 Total cost:    <b>${week.totalCost} den</b>

🕐 <b>Device usage this week:</b>
  💡 Light:   ${week.lightHours}h
  📺 TV:      ${week.tvHours}h
  ❄️ Fridge:  ${week.fridgeHours}h

📊 Daily average:
  ⚡ ${(week.totalKwh  / 7).toFixed(3)} kWh/day
  💰 ${(week.totalCost / 7).toFixed(2)} den/day`;

  return [text, BACK_BUTTON];
}

function buildMainMenu() {
  return [
`🏠 <b>Smart Home EMS</b>
<i>Your energy management assistant</i>

What would you like to check?`, MAIN_MENU];
}

// ============================================================
//  UPDATE DISPATCHER
// ============================================================

async function handleUpdate(update) {
  // Text command (e.g. /start, /menu)
  if (update.message) {
    const chatId = update.message.chat.id;
    const text   = update.message.text ?? "";

    if (text.startsWith("/start") || text.startsWith("/menu")) {
      const [msg, kb] = buildMainMenu();
      await sendMessage(chatId, msg, kb);
    } else {
      const [msg, kb] = buildMainMenu();
      await sendMessage(chatId, msg, kb);
    }
  }

  // Inline button tap
  if (update.callback_query) {
    const query    = update.callback_query;
    const chatId   = query.message.chat.id;
    const msgId    = query.message.message_id;
    const action   = query.data;

    await answerCallback(query.id);

    let result;
    switch (action) {
      case "menu":      result = buildMainMenu();     break;
      case "summary":   result = buildSummary();      break;
      case "devices":   result = buildDevices();      break;
      case "energy":    result = buildEnergy();       break;
      case "cost":      result = buildCost();         break;
      case "ai_tips":   result = buildAITips();       break;
      case "week":      result = buildWeekReport();   break;
      case "dashboard":
        await editMessage(chatId, msgId,
          `🔗 <b>Dashboard Link</b>\n\n<a href="${DASHBOARD}">${DASHBOARD}</a>`,
          BACK_BUTTON
        );
        return;
      default:
        result = buildMainMenu();
    }

    const [msg, kb] = await result;
    await editMessage(chatId, msgId, msg, kb);
  }
}

// ============================================================
//  POLLING LOOP — runs inside the Express process
// ============================================================

async function startPolling() {
  if (!TOKEN) {
    console.log("[Bot] TELEGRAM_TOKEN not set — bot disabled");
    return;
  }
  console.log("[Bot] Telegram bot polling started");

  const poll = async () => {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        if (update.update_id > lastUpdateId) {
          lastUpdateId = update.update_id;
          handleUpdate(update).catch((e) =>
            console.error("[Bot] Handler error:", e.message)
          );
        }
      }
    } catch (e) {
      console.error("[Bot] Poll error:", e.message);
    }
    setTimeout(poll, 3000);
  };

  poll();
}

module.exports = { startPolling };