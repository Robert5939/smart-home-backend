/**
 * ============================================================
 *  Telegram Alert Service
 * ============================================================
 */

const https = require("https");

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const DASHBOARD = process.env.DASHBOARD_URL || "https://your-dashboard.netlify.app";

function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    console.log("[Telegram] Skipped — TOKEN or CHAT_ID not set");
    return;
  }
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" });
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
    if (res.statusCode !== 200)
      console.error(`[Telegram] Failed — HTTP ${res.statusCode}`);
  });
  req.on("error", (e) => console.error("[Telegram] Error:", e.message));
  req.write(body);
  req.end();
}

function footer() {
  return `\n\n🔗 <a href="${DASHBOARD}">Open Dashboard</a>\n⏰ <i>${timestamp()}</i>`;
}

function timestamp() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/Skopje",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ── Alerts ────────────────────────────────────────────────

function alertFridgeFailure() {
  sendTelegram(
`🚨 <b>FRIDGE FAILURE DETECTED</b>

Your fridge has stopped working!
Auto-recovery will attempt in 5 seconds.
Check the device immediately.${footer()}`);
}

function alertFridgeRecovered() {
  sendTelegram(
`✅ <b>Fridge Recovered</b>

Fridge is back to normal operation.${footer()}`);
}

function alertTVWarning() {
  sendTelegram(
`📺 <b>TV — Still Watching?</b>

No motion detected for 3 minutes.
TV will auto-off in 2 more minutes if no activity.${footer()}`);
}

function alertTVAutoOff() {
  sendTelegram(
`📺 <b>TV Turned Off Automatically</b>

No motion detected for 5 minutes.
TV switched off to save energy.${footer()}`);
}

function alertTVManualOff() {
  sendTelegram(
`📺 <b>TV Turned Off</b>

TV was switched off manually.${footer()}`);
}

function alertLightAutoOff() {
  sendTelegram(
`💡 <b>Light Turned Off Automatically</b>

No motion detected for 30 seconds.
Light switched off to save energy.${footer()}`);
}

function alertLightManualOff() {
  sendTelegram(
`💡 <b>Light Turned Off</b>

Light was switched off manually.${footer()}`);
}

function alertTariffChange(newTariff) {
  const cheap = newTariff <= 5;
  sendTelegram(
`⚡ <b>Tariff Changed — ${cheap ? "CHEAP 🟢" : "PEAK 🔴"}</b>

Current rate: <b>${newTariff} den/kWh</b>
${cheap
  ? "✅ Good time to run heavy appliances."
  : "⚠️ Consider deferring loads to 22:00–07:00."}${footer()}`);
}

function alertDailySummary(data) {
  const { totalEnergyKwh, costDen, runtimeLightMin, runtimeTvMin, runtimeFridgeMin } = data;
  sendTelegram(
`📊 <b>Daily Energy Summary</b>

⚡ Total energy: <b>${Number(totalEnergyKwh).toFixed(3)} kWh</b>
💰 Total cost:   <b>${Number(costDen).toFixed(2)} den</b>

🕐 <b>Device runtimes today:</b>
  💡 Light:   ${runtimeLightMin} min
  📺 TV:      ${runtimeTvMin} min
  ❄️ Fridge:  ${runtimeFridgeMin} min${footer()}`);
}

function alertSystemStartup() {
  sendTelegram(
`🏠 <b>Smart Home EMS Online</b>

Backend server started successfully.
ESP32 is connected and sending data.${footer()}`);
}

module.exports = {
  sendTelegram,
  alertFridgeFailure,
  alertFridgeRecovered,
  alertTVWarning,
  alertTVAutoOff,
  alertTVManualOff,
  alertLightAutoOff,
  alertLightManualOff,
  alertTariffChange,
  alertDailySummary,
  alertSystemStartup,
};