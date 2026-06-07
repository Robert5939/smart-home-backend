const mongoose = require("mongoose");

const readingSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },

  lightOn:  Boolean,
  tvOn:     Boolean,
  fridgeOn: Boolean,

  // Cumulative accumulators (since last boot)
  energyLightKwh:  Number,
  energyTvKwh:     Number,
  energyFridgeKwh: Number,
  totalEnergyKwh:  Number,
  costDen:         Number,

  // ── NEW: energy added in THIS 30-second interval only ──
  // Used for daily bar charts — immune to reboots
  intervalEnergyKwh: { type: Number, default: 0 },
  intervalCostDen:   { type: Number, default: 0 },

  tariff: Number,

  runtimeLightMin:  Number,
  runtimeTvMin:     Number,
  runtimeFridgeMin: Number,

  virtualHour: Number,
  virtualMin:  Number,
  virtualDay:  Number,

  fastMode:       Boolean,
  wifiConnected:  Boolean,
  motionDetected: Boolean,
  fridgeFailures: Number,
  autoOff:        Boolean,
  tvWarning:      Boolean,

  measuredPowerLight: Number,
  measuredPowerTv:    Number,
});

module.exports = mongoose.model("Reading", readingSchema);