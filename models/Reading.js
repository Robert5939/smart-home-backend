const mongoose = require("mongoose");

const readingSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now
  },

  lightOn: Boolean,
  tvOn: Boolean,
  fridgeOn: Boolean,

  energyLightKwh: Number,
  energyTvKwh: Number,
  energyFridgeKwh: Number,

  totalEnergyKwh: Number,

  costDen: Number,

  tariff: Number,

  runtimeLightMin: Number,
  runtimeTvMin: Number,
  runtimeFridgeMin: Number,

  virtualHour: Number,
  virtualMin: Number,

  fastMode: Boolean
});

module.exports = mongoose.model("Reading", readingSchema);