/**
 * ============================================================
 *  Smart Home EMS — Database Seed Script
 *  Generates 60 days of data ending on June 6, 2026
 *  Run: node seed.js
 * ============================================================
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Reading  = require("./models/Reading");

// ── Config ────────────────────────────────────────────────
const END_DATE   = new Date("2026-06-06T23:59:00Z");
const DAYS       = 60;
const INTERVAL_MIN = 30;

const POWER_LIGHT  = 15;
const POWER_TV     = 120;
const POWER_FRIDGE = 180;

const TARIFF_CHEAP     = 5;
const TARIFF_EXPENSIVE = 10;

// ── Helpers ───────────────────────────────────────────────

function chance(p) { return Math.random() < p; }

function jitter(val, pct = 0.10) {
  return val * (1 + (Math.random() * 2 - 1) * pct);
}

function isCheap(hour, dayOfWeek) {
  return dayOfWeek === 0 ||
    (hour >= 13 && hour < 15) ||
    hour >= 22 ||
    hour < 7;
}

function deviceStates(hour, dayOfWeek, fridgeFailing) {
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;
  let lightProb = 0, tvProb = 0;

  if      (hour >= 6  && hour < 9)  lightProb = 0.8;
  else if (hour >= 9  && hour < 17) lightProb = weekend ? 0.4 : 0.15;
  else if (hour >= 17 && hour < 23) lightProb = 0.95;
  else                              lightProb = 0.05;

  if      (hour >= 7  && hour < 10) tvProb = weekend ? 0.5 : 0.2;
  else if (hour >= 10 && hour < 17) tvProb = weekend ? 0.5 : 0.1;
  else if (hour >= 17 && hour < 23) tvProb = 0.9;
  else                              tvProb = 0.03;

  return {
    lightOn:  chance(lightProb),
    tvOn:     chance(tvProb),
    fridgeOn: !fridgeFailing,
  };
}

// ── Main ──────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("MongoDB Connected");

  // Only delete seeded data (fastMode: false), preserve real ESP32 data
  const deleted = await Reading.deleteMany({ fastMode: false });
  console.log(`Deleted ${deleted.deletedCount} old seeded records`);

  const readings  = [];
  const totalReadings = DAYS * (1440 / INTERVAL_MIN);

  // Work backwards from END_DATE
  const startDate = new Date(END_DATE);
  startDate.setDate(startDate.getDate() - DAYS);
  startDate.setHours(0, 0, 0, 0);

  let energyLight  = 0;
  let energyTV     = 0;
  let energyFridge = 0;
  let totalCost    = 0;
  let runtimeLight = 0;
  let runtimeTV    = 0;
  let runtimeFridge= 0;

  // Scatter fridge failures across the period
  const fridgeFailures = new Set([100, 250, 580, 900, 1300, 1800, 2200]);

  for (let i = 0; i < totalReadings; i++) {
    const timestamp  = new Date(startDate.getTime() + i * INTERVAL_MIN * 60000);
    const hour       = timestamp.getUTCHours();
    const dayOfWeek  = timestamp.getUTCDay();

    const fridgeFailing = fridgeFailures.has(i);
    const { lightOn, tvOn, fridgeOn } = deviceStates(hour, dayOfWeek, fridgeFailing);

    const hours  = INTERVAL_MIN / 60;
    const cheap  = isCheap(hour, dayOfWeek);
    const tariff = cheap ? TARIFF_CHEAP : TARIFF_EXPENSIVE;

    const dLight  = lightOn  ? jitter((POWER_LIGHT  * hours) / 1000) : 0;
    const dTV     = tvOn     ? jitter((POWER_TV     * hours) / 1000) : 0;
    const dFridge = fridgeOn ? jitter((POWER_FRIDGE * hours) / 1000) : 0;

    energyLight  += dLight;
    energyTV     += dTV;
    energyFridge += dFridge;
    totalCost    += (dLight + dTV + dFridge) * tariff;

    if (lightOn)  runtimeLight  += INTERVAL_MIN;
    if (tvOn)     runtimeTV     += INTERVAL_MIN;
    if (fridgeOn) runtimeFridge += INTERVAL_MIN;

    const totalEnergy = energyLight + energyTV + energyFridge;

    readings.push({
      timestamp,
      lightOn,
      tvOn,
      fridgeOn,
      energyLightKwh:  Number(energyLight.toFixed(4)),
      energyTvKwh:     Number(energyTV.toFixed(4)),
      energyFridgeKwh: Number(energyFridge.toFixed(4)),
      totalEnergyKwh:  Number(totalEnergy.toFixed(4)),
      costDen:         Number(totalCost.toFixed(2)),
      tariff,
      runtimeLightMin:  Math.round(runtimeLight),
      runtimeTvMin:     Math.round(runtimeTV),
      runtimeFridgeMin: Math.round(runtimeFridge),
      virtualHour:  hour,
      virtualMin:   timestamp.getUTCMinutes(),
      fastMode:     false,
      wifiConnected: true,
      motionDetected: lightOn || tvOn,
    });
  }

  // Insert in batches of 500 to avoid memory issues
  const BATCH = 500;
  for (let i = 0; i < readings.length; i += BATCH) {
    await Reading.insertMany(readings.slice(i, i + BATCH));
    console.log(`Inserted ${Math.min(i + BATCH, readings.length)}/${readings.length}`);
  }

  const last = readings[readings.length - 1];
  console.log("\n==========================");
  console.log("FINAL TOTALS");
  console.log("==========================");
  console.log("Energy:", last.totalEnergyKwh.toFixed(2), "kWh");
  console.log("Cost:  ", last.costDen.toFixed(2), "den");
  console.log("Period: " + startDate.toDateString() + " → " + END_DATE.toDateString());
  console.log("==========================\n");

  await mongoose.disconnect();
  console.log("Seed complete.");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});