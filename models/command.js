/**
 * Command model — stores pending device commands
 * from Telegram bot to be picked up by ESP32
 */
const mongoose = require("mongoose");

const commandSchema = new mongoose.Schema({
  device:    { type: String, enum: ["light", "tv", "fridge"], required: true },
  action:    { type: String, enum: ["on", "off"], required: true },
  executed:  { type: Boolean, default: false },
  createdAt: { type: Date,    default: Date.now, expires: 60 }, // auto-delete after 60s
});

module.exports = mongoose.model("Command", commandSchema);