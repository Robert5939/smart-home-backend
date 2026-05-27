require("dotenv").config();

const Reading   = require("./models/Reading");
const express   = require("express");
const mongoose  = require("mongoose");
const cors      = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error("MongoDB Error:", err));

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "running", database: "connected" });
});

// ── POST reading (from ESP32) ─────────────────────────────
app.post("/api/readings", async (req, res) => {
  try {
    const reading = await Reading.create(req.body);
    res.status(201).json({ success: true, data: reading });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET latest 1440 raw readings (30 days × 48/day) ───────
app.get("/api/readings", async (req, res) => {
  try {
    const readings = await Reading
      .find()
      .sort({ timestamp: -1 })
      .limit(1440);

    res.json({ success: true, count: readings.length, data: readings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET daily aggregates (for charts) ────────────────────
// Groups all readings by calendar day, computes:
//   - kWh consumed that day (last reading's total - first reading's total)
//   - cost added that day (same delta approach)
//   - avg tariff, device on-time counts
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
          // First and last totalEnergyKwh of the day
          firstEnergy: { $first: "$totalEnergyKwh" },
          lastEnergy:  { $last:  "$totalEnergyKwh"  },
          firstCost:   { $first: "$costDen" },
          lastCost:    { $last:  "$costDen"  },
          // Average active device count per reading (0-3)
          avgDevicesOn: {
            $avg: {
              $add: [
                { $cond: ["$lightOn",  1, 0] },
                { $cond: ["$tvOn",     1, 0] },
                { $cond: ["$fridgeOn", 1, 0] },
              ]
            }
          },
          avgTariff:     { $avg: "$tariff" },
          maxRuntimeTV:  { $max: "$runtimeTvMin" },
          readings:      { $sum: 1 },
          dateRef:       { $first: "$timestamp" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    // Compute daily delta (energy/cost used that day, not cumulative)
    const result = days.map((d, i) => {
      const prevEnergy = i > 0 ? days[i - 1].lastEnergy : d.firstEnergy;
      const prevCost   = i > 0 ? days[i - 1].lastCost   : d.firstCost;

      const dailyKwh  = Math.max(0, d.lastEnergy - prevEnergy);
      const dailyCost = Math.max(0, d.lastCost   - prevCost);

      const date = new Date(d.dateRef);
      const label = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

      return {
        label,
        dailyKwh:    Number(dailyKwh.toFixed(3)),
        dailyCost:   Number(dailyCost.toFixed(2)),
        avgDevicesOn: Number(d.avgDevicesOn.toFixed(2)),
        avgTariff:    Number(d.avgTariff.toFixed(1)),
        readings:     d.readings,
      };
    });

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
          firstEnergy:  { $first: "$totalEnergyKwh" },
          lastEnergy:   { $last:  "$totalEnergyKwh"  },
          firstCost:    { $first: "$costDen" },
          lastCost:     { $last:  "$costDen"  },
          lightOnCount: { $sum: { $cond: ["$lightOn", 1, 0] } },
          tvOnCount:    { $sum: { $cond: ["$tvOn",    1, 0] } },
          total:        { $sum: 1 },
        }
      },
      { $sort: { _id: 1 } },
    ]);

    const result = hourly.map((h) => ({
      hour:      `${String(h._id).padStart(2,"0")}:00`,
      kwh:       Number(Math.max(0, h.lastEnergy - h.firstEnergy).toFixed(4)),
      cost:      Number(Math.max(0, h.lastCost   - h.firstCost).toFixed(3)),
      lightPct:  h.total > 0 ? Math.round((h.lightOnCount / h.total) * 100) : 0,
      tvPct:     h.total > 0 ? Math.round((h.tvOnCount    / h.total) * 100) : 0,
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));