require("dotenv").config();

const http    = require("http");
const https   = require("https");
const Reading = require("./models/Reading");
const Command = require("./models/command");
const express = require("express");
const mongoose= require("mongoose");
const cors    = require("cors");
const tg      = require("./telegram");

const app = express();
app.use(cors());
app.use(express.json());

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => { console.log("MongoDB Connected"); tg.alertSystemStartup(); })
  .catch((err) => console.error("MongoDB Error:", err));

// ── State tracking ────────────────────────────────────────
let prevState = { fridgeOn: true, tvOn: false, lightOn: false, tariff: null };
let lastTariffAlert      = 0;
let lastDailySummaryDate = null;
let lastFridgeFailAlert  = 0;

const TARIFF_COOLDOWN_MS      = 60 * 60 * 1000;
const FRIDGE_FAIL_COOLDOWN_MS = 30 * 1000;

// Track previous reading's cumulative values to compute interval delta
let prevCumulativeEnergy = null;
let prevCumulativeCost   = null;

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "running", database: "connected" });
});

// ── POST reading (from ESP32) ─────────────────────────────
app.post("/api/readings", async (req, res) => {
  try {
    const d = req.body;

    // Compute interval delta on the server — this is reboot-safe
    // because we track previous cumulative value server-side
    let intervalEnergy = 0;
    let intervalCost   = 0;

    if (prevCumulativeEnergy !== null && d.totalEnergyKwh >= prevCumulativeEnergy) {
      // Normal case: energy increased since last reading
      intervalEnergy = d.totalEnergyKwh - prevCumulativeEnergy;
      intervalCost   = d.costDen        - prevCumulativeCost;
    } else if (prevCumulativeEnergy !== null && d.totalEnergyKwh < prevCumulativeEnergy) {
      // Reboot detected: ESP32 reset to 0 or lower value
      // Use the raw reading as the interval (energy added since boot)
      intervalEnergy = d.totalEnergyKwh;
      intervalCost   = d.costDen;
      console.log("[Server] Reboot detected — using raw values as interval delta");
    }

    // Clamp negatives (shouldn't happen but just in case)
    intervalEnergy = Math.max(0, intervalEnergy);
    intervalCost   = Math.max(0, intervalCost);

    // Update tracking
    prevCumulativeEnergy = d.totalEnergyKwh;
    prevCumulativeCost   = d.costDen;

    // Save reading with interval values
    const reading = await Reading.create({
      ...d,
      intervalEnergyKwh: Number(intervalEnergy.toFixed(6)),
      intervalCostDen:   Number(intervalCost.toFixed(4)),
    });

    const now = Date.now();

    // Telegram alerts
    if (d.fridgeOn === false && (now - lastFridgeFailAlert) > FRIDGE_FAIL_COOLDOWN_MS) {
      lastFridgeFailAlert = now; tg.alertFridgeFailure();
    }
    if (prevState.fridgeOn === false && d.fridgeOn === true) tg.alertFridgeRecovered();
    if (d.tvWarning === true) tg.alertTVWarning();
    if (prevState.tvOn === true && d.tvOn === false) {
      d.autoOff ? tg.alertTVAutoOff() : tg.alertTVManualOff();
    }
    if (prevState.lightOn === true && d.lightOn === false) {
      d.autoOff ? tg.alertLightAutoOff() : tg.alertLightManualOff();
    }
    if (prevState.tariff !== null && prevState.tariff !== d.tariff &&
        (now - lastTariffAlert) > TARIFF_COOLDOWN_MS) {
      lastTariffAlert = now; tg.alertTariffChange(d.tariff);
    }
    if (d.virtualHour === 8) {
      const today = new Date().toDateString();
      if (lastDailySummaryDate !== today) {
        lastDailySummaryDate = today; tg.alertDailySummary(d);
      }
    }

    prevState = { fridgeOn: d.fridgeOn, tvOn: d.tvOn, lightOn: d.lightOn, tariff: d.tariff };
    res.status(201).json({ success: true, data: reading });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET latest 1440 raw readings ──────────────────────────
app.get("/api/readings", async (req, res) => {
  try {
    const readings = await Reading.find().sort({ timestamp: -1 }).limit(1440);
    res.json({ success: true, count: readings.length, data: readings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET single latest reading (ESP32 boot sync) ───────────
app.get("/api/readings/last", async (req, res) => {
  try {
    const reading = await Reading.findOne().sort({ timestamp: -1 });
    if (!reading) return res.json({ success: false, message: "No readings found" });
    res.json({ success: true, data: reading });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET daily aggregates — uses intervalEnergyKwh (reboot-safe) ──
app.get("/api/readings/daily", async (req, res) => {
  try {
    const days = await Reading.aggregate([
      {
        $group: {
          _id: {
            year:  { $year:  "$timestamp" },
            month: { $month: "$timestamp" },
            day:   { $dayOfMonth: "$timestamp" },
          },
          // SUM of interval values = total energy for that day regardless of reboots
          dailyKwh:    { $sum: "$intervalEnergyKwh" },
          dailyCost:   { $sum: "$intervalCostDen"   },
          avgDevicesOn: {
            $avg: {
              $add: [
                { $cond: ["$lightOn",  1, 0] },
                { $cond: ["$tvOn",     1, 0] },
                { $cond: ["$fridgeOn", 1, 0] },
              ]
            }
          },
          avgTariff: { $avg: "$tariff" },
          readings:  { $sum: 1 },
          dateRef:   { $first: "$timestamp" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    const result = days.map((d) => ({
      label:        new Date(d.dateRef).toLocaleDateString("en-GB", {
                      day: "2-digit", month: "short", timeZone: "Europe/Skopje"
                    }),
      dailyKwh:     Number(Math.max(0, d.dailyKwh).toFixed(3)),
      dailyCost:    Number(Math.max(0, d.dailyCost).toFixed(2)),
      avgDevicesOn: Number(d.avgDevicesOn.toFixed(2)),
      avgTariff:    Number(d.avgTariff.toFixed(1)),
      readings:     d.readings,
    }));

    res.json({ success: true, count: result.length, data: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET today's hourly breakdown ──────────────────────────
app.get("/api/readings/today", async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const hourly = await Reading.aggregate([
      { $match: { timestamp: { $gte: startOfDay } } },
      {
        $group: {
          _id:          { $hour: "$timestamp" },
          kwh:          { $sum: "$intervalEnergyKwh" },
          cost:         { $sum: "$intervalCostDen"   },
          lightOnCount: { $sum: { $cond: ["$lightOn", 1, 0] } },
          tvOnCount:    { $sum: { $cond: ["$tvOn",    1, 0] } },
          total:        { $sum: 1 },
        }
      },
      { $sort: { _id: 1 } },
    ]);

    const result = hourly.map((h) => ({
      hour:     `${String(h._id).padStart(2, "0")}:00`,
      kwh:      Number(Math.max(0, h.kwh).toFixed(4)),
      cost:     Number(Math.max(0, h.cost).toFixed(3)),
      lightPct: h.total > 0 ? Math.round((h.lightOnCount / h.total) * 100) : 0,
      tvPct:    h.total > 0 ? Math.round((h.tvOnCount    / h.total) * 100) : 0,
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── POST command (Telegram → ESP32) ──────────────────────
app.post("/api/commands", async (req, res) => {
  try {
    const { device, action } = req.body;
    if (!device || !action)
      return res.status(400).json({ success: false, message: "device and action required" });
    await Command.deleteMany({ device, executed: false });
    const command = await Command.create({ device, action });
    console.log(`[Command] ${device} → ${action}`);
    res.status(201).json({ success: true, data: command });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET pending commands (ESP32 polls this) ───────────────
app.get("/api/commands/pending", async (req, res) => {
  try {
    const commands = await Command.find({ executed: false });
    if (commands.length > 0) {
      await Command.updateMany({ executed: false }, { executed: true });
      console.log(`[Command] Delivered ${commands.length} command(s)`);
    }
    res.json({ success: true, data: commands });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Keepalive ping every 14 min (prevents Render free tier sleep)
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    setInterval(() => {
      const client = SELF_URL.startsWith("https") ? https : http;
      client.get(`${SELF_URL}/`, (res) => {
        console.log("[Keepalive] Pinged — status:", res.statusCode);
      }).on("error", (e) => console.error("[Keepalive] Error:", e.message));
    }, 14 * 60 * 1000);
    console.log("[Keepalive] Enabled");
  }

  // Telegram webhook
  const { handleUpdate, setupWebhook } = require("./telegramBot");
  if (SELF_URL) await setupWebhook(SELF_URL);

  app.post("/telegram-webhook", express.json(), async (req, res) => {
    res.sendStatus(200);
    try { await handleUpdate(req.body); }
    catch (e) { console.error("[Bot] Webhook error:", e.message); }
  });
});