/**
 * ============================================================
 *  Telegram Alert Service
 *  Place this file in your backend/ folder
 *  
 *  Required .env variables:
 *    TELEGRAM_TOKEN=your_bot_token
 *    TELEGRAM_CHAT_ID=your_chat_id
 * ============================================================
 */

const https = require("https");

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a message via Telegram Bot API.
 * Uses plain https — no extra dependencies needed.
 */
function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    console.log("[Telegram] Skipped — TOKEN or CHAT_ID not set in .env");
    return;
  }

  const body = JSON.stringify({
    chat_id:    CHAT_ID,
    text:       text,
    parse_mode: "HTML",
  });

  const options = {
    hostname: "api.telegram.org",
    path:     `/bot${TOKEN}/sendMessage`,
    method:   "POST",
    headers:  {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[Telegram] Failed — HTTP ${res.statusCode}`);
    }
  });

  req.on("error", (e) => console.error("[Telegram] Error:", e.message));
  req.write(body);
  req.end();
}

// ── Alert templates ───────────────────────────────────────

function alertFridgeFailure() {
  sendTelegram(
`🚨 <b>FRIDGE FAILURE DETECTED</b>

Your fridge has stopped working.
Auto-recovery will attempt in 5 seconds.

⏰ <i>${timestamp()}</i>`
  );
}

function alertFridgeRecovered() {
  sendTelegram(
`✅ <b>Fridge Recovered</b>

Fridge is back to normal operation.

⏰ <i>${timestamp()}</i>`
  );
}

function alertTVAutoOff() {
  sendTelegram(
`📺 <b>TV Auto-Off</b>

TV was turned off automatically — no motion detected for 5 minutes.

⏰ <i>${timestamp()}</i>`
  );
}

function alertLightAutoOff() {
  sendTelegram(
`💡 <b>Light Auto-Off</b>

Light was turned off automatically — no motion detected for 30 seconds.

⏰ <i>${timestamp()}</i>`
  );
}

function alertTariffChange(newTariff) {
  const cheap = newTariff <= 5;
  sendTelegram(
`⚡ <b>Tariff Changed — ${cheap ? "CHEAP 🟢" : "PEAK 🔴"}</b>

Current rate: <b>${newTariff} den/kWh</b>
${cheap
  ? "Good time to run heavy appliances."
  : "Consider deferring non-essential loads to 22:00–07:00."}

⏰ <i>${timestamp()}</i>`
  );
}

function alertDailySummary(data) {
  const { totalEnergyKwh, costDen, runtimeLightMin, runtimeTvMin, runtimeFridgeMin } = data;
  sendTelegram(
`📊 <b>Daily Summary</b>

⚡ Total energy: <b>${Number(totalEnergyKwh).toFixed(3)} kWh</b>
💰 Total cost:   <b>${Number(costDen).toFixed(2)} den</b>

🕐 Device runtimes:
  💡 Light:  ${runtimeLightMin} min
  📺 TV:     ${runtimeTvMin} min
  ❄️ Fridge: ${runtimeFridgeMin} min

⏰ <i>${timestamp()}</i>`
  );
}

function alertSystemStartup() {
  sendTelegram(
`🏠 <b>Smart Home EMS Online</b>

Backend server started successfully.
ESP32 is connected and sending data.

⏰ <i>${timestamp()}</i>`
  );
}

function alertMotionDetected() {
  sendTelegram(
`🚶 <b>Motion Detected</b>

PIR sensor triggered.

⏰ <i>${timestamp()}</i>`
  );
}

// ── Helper ────────────────────────────────────────────────

function timestamp() {
  return new Date().toLocaleString("en-GB", {
    day:    "2-digit",
    month:  "short",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

module.exports = {
  sendTelegram,
  alertFridgeFailure,
  alertFridgeRecovered,
  alertTVAutoOff,
  alertLightAutoOff,
  alertTariffChange,
  alertDailySummary,
  alertSystemStartup,
  alertMotionDetected,
};