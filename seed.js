require("dotenv").config();
const mongoose = require("mongoose");
const Reading = require("./models/Reading");

// =====================================================
// CONFIG
// =====================================================

const DAYS = 30;
const READINGS_PER_DAY = 48;
const INTERVAL_MIN = 30;

const POWER_LIGHT  = 15;
const POWER_TV     = 120;
const POWER_FRIDGE = 180;

const TARIFF_CHEAP      = 5;
const TARIFF_EXPENSIVE  = 10;

// =====================================================
// HELPERS
// =====================================================

function chance(probability) {
  return Math.random() < probability;
}

function jitter(value, percent = 0.10) {
  return value * (1 + ((Math.random() * 2 - 1) * percent));
}

function isCheap(hour, day) {
  return (
    day === 0 ||
    (hour >= 13 && hour < 15) ||
    hour >= 22 ||
    hour < 7
  );
}

function deviceStates(hour, day, fridgeFailing) {
  const weekend = day === 0 || day === 6;

  let lightProb = 0;
  let tvProb    = 0;

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

// =====================================================
// MAIN
// =====================================================

async function seed() {

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("MongoDB Connected");

  const deleted = await Reading.deleteMany({});
  console.log(`Deleted ${deleted.deletedCount} old records`);

  const readings = [];

  // Energy accumulators (kWh)
  let energyLight  = 0;
  let energyTV     = 0;
  let energyFridge = 0;

  // Runtime accumulators (virtual minutes)
  let runtimeLight  = 0;
  let runtimeTV     = 0;
  let runtimeFridge = 0;

  // ── KEY FIX ──────────────────────────────────────────
  // Cost is also an accumulator. Each interval adds:
  //   intervalEnergy (kWh) * currentTariff
  // This prevents spikes when the tariff switches, because
  // we're only pricing the *new* energy at the new rate —
  // not re-pricing all historical energy at the new rate.
  let totalCost = 0;

  const totalReadings = DAYS * READINGS_PER_DAY;

  const fridgeFailures = new Set([100, 250, 420, 650, 890, 1120, 1300]);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);
  startDate.setHours(0, 0, 0, 0);

  for (let i = 0; i < totalReadings; i++) {

    const totalVirtualMin = i * INTERVAL_MIN;
    const virtualHour     = Math.floor(totalVirtualMin / 60) % 24;
    const virtualMin      = totalVirtualMin % 60;
    const virtualDay      = Math.floor(totalVirtualMin / 1440) % 7;

    const timestamp = new Date(startDate.getTime() + i * INTERVAL_MIN * 60000);

    const fridgeFailing = fridgeFailures.has(i);

    const { lightOn, tvOn, fridgeOn } = deviceStates(virtualHour, virtualDay, fridgeFailing);

    const hours  = INTERVAL_MIN / 60;
    const cheap  = isCheap(virtualHour, virtualDay);
    const tariff = cheap ? TARIFF_CHEAP : TARIFF_EXPENSIVE;

    // Compute energy added THIS interval only
    const deltaLight  = lightOn  ? jitter((POWER_LIGHT  * hours) / 1000) : 0;
    const deltaTV     = tvOn     ? jitter((POWER_TV     * hours) / 1000) : 0;
    const deltaFridge = fridgeOn ? jitter((POWER_FRIDGE * hours) / 1000) : 0;
    const deltaEnergy = deltaLight + deltaTV + deltaFridge;

    // Accumulate energy
    energyLight  += deltaLight;
    energyTV     += deltaTV;
    energyFridge += deltaFridge;

    // Accumulate runtime
    if (lightOn)  runtimeLight  += INTERVAL_MIN;
    if (tvOn)     runtimeTV     += INTERVAL_MIN;
    if (fridgeOn) runtimeFridge += INTERVAL_MIN;

    // Accumulate cost: only THIS interval's energy at THIS interval's tariff
    // No more spikes when tariff switches — historical cost is already locked in
    totalCost += deltaEnergy * tariff;

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

      costDen: Number(totalCost.toFixed(2)),

      tariff,

      runtimeLightMin:  Math.round(runtimeLight),
      runtimeTvMin:     Math.round(runtimeTV),
      runtimeFridgeMin: Math.round(runtimeFridge),

      virtualHour,
      virtualMin,

      fastMode: false,
    });
  }

  await Reading.insertMany(readings);
  console.log(`Inserted ${readings.length} readings`);

  const last = readings[readings.length - 1];
  console.log("\n==========================");
  console.log("FINAL TOTALS");
  console.log("==========================");
  console.log("Energy:", last.totalEnergyKwh.toFixed(2), "kWh");
  console.log("Cost:  ", last.costDen.toFixed(2), "den");
  console.log("Light runtime:", last.runtimeLightMin, "min");
  console.log("TV runtime:   ", last.runtimeTvMin, "min");
  console.log("Fridge runtime:", last.runtimeFridgeMin, "min");
  console.log("==========================\n");

  await mongoose.disconnect();
  console.log("Seed complete.");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});