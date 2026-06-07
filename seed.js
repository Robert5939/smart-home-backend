/**
 * Smart Home EMS — Seed Script
 * Generates 60 days ending June 6, 2026
 * ONLY deletes readings with fastMode:false AND timestamp before June 7
 * Preserves real ESP32 readings
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Reading  = require("./models/Reading");

const END_DATE     = new Date("2026-06-06T23:30:00.000Z");
const DAYS         = 60;
const INTERVAL_MIN = 30;
const POWER_LIGHT  = 15;
const POWER_TV     = 120;
const POWER_FRIDGE = 180;
const TARIFF_CHEAP = 5, TARIFF_EXP = 10;

function chance(p) { return Math.random() < p; }
function jitter(v, p=0.08) { return v * (1 + (Math.random()*2-1)*p); }

function isCheap(h, dow) {
  return dow===0 || (h>=13&&h<15) || h>=22 || h<7;
}

function deviceStates(h, dow, fail) {
  const wk = dow===0||dow===6;
  let lp=0, tp=0;
  if      (h>=6&&h<9)  lp=0.8;
  else if (h>=9&&h<17) lp=wk?0.4:0.15;
  else if (h>=17&&h<23)lp=0.95;
  else                 lp=0.05;
  if      (h>=7&&h<10) tp=wk?0.5:0.2;
  else if (h>=10&&h<17)tp=wk?0.5:0.1;
  else if (h>=17&&h<23)tp=0.9;
  else                 tp=0.03;
  return { lightOn:chance(lp), tvOn:chance(tp), fridgeOn:!fail };
}

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("MongoDB Connected");

  // Only delete old seeded data (before June 7) — preserve real ESP32 data
  const cutoff = new Date("2026-06-07T00:00:00.000Z");
  const deleted = await Reading.deleteMany({
    fastMode: false,
    timestamp: { $lt: cutoff }
  });
  console.log(`Deleted ${deleted.deletedCount} old seeded records`);

  const startDate = new Date(END_DATE);
  startDate.setDate(startDate.getDate() - DAYS);
  startDate.setHours(0, 0, 0, 0);

  const totalReadings = DAYS * (1440 / INTERVAL_MIN);
  const readings = [];

  let eL=0, eT=0, eF=0, cost=0, rL=0, rT=0, rF=0;
  const fails = new Set([80,200,450,700,1100,1600,2100]);

  for (let i = 0; i < totalReadings; i++) {
    const ts  = new Date(startDate.getTime() + i * INTERVAL_MIN * 60000);
    const h   = ts.getUTCHours();
    const dow = ts.getUTCDay();
    const fail= fails.has(i);
    const { lightOn, tvOn, fridgeOn } = deviceStates(h, dow, fail);
    const hrs    = INTERVAL_MIN / 60;
    const cheap  = isCheap(h, dow);
    const tariff = cheap ? TARIFF_CHEAP : TARIFF_EXP;
    const dL = lightOn  ? jitter((POWER_LIGHT  * hrs)/1000) : 0;
    const dT = tvOn     ? jitter((POWER_TV     * hrs)/1000) : 0;
    const dF = fridgeOn ? jitter((POWER_FRIDGE * hrs)/1000) : 0;
    eL += dL; eT += dT; eF += dF;
    cost += (dL+dT+dF) * tariff;
    if (lightOn)  rL += INTERVAL_MIN;
    if (tvOn)     rT += INTERVAL_MIN;
    if (fridgeOn) rF += INTERVAL_MIN;

    readings.push({
      timestamp: ts,
      lightOn, tvOn, fridgeOn,
      energyLightKwh:  Number(eL.toFixed(4)),
      energyTvKwh:     Number(eT.toFixed(4)),
      energyFridgeKwh: Number(eF.toFixed(4)),
      totalEnergyKwh:  Number((eL+eT+eF).toFixed(4)),
      costDen:         Number(cost.toFixed(2)),
      tariff,
      runtimeLightMin:  Math.round(rL),
      runtimeTvMin:     Math.round(rT),
      runtimeFridgeMin: Math.round(rF),
      virtualHour: h,
      virtualMin:  ts.getUTCMinutes(),
      fastMode: false,
      wifiConnected: true,
      motionDetected: lightOn||tvOn,
    });
  }

  for (let i = 0; i < readings.length; i += 500) {
    await Reading.insertMany(readings.slice(i, i+500));
    process.stdout.write(`\rInserted ${Math.min(i+500, readings.length)}/${readings.length}`);
  }

  const last = readings[readings.length-1];
  console.log("\n\nFINAL: " + last.totalEnergyKwh + " kWh, " + last.costDen + " den");
  console.log("Period: " + startDate.toDateString() + " → " + END_DATE.toDateString());
  await mongoose.disconnect();
  console.log("Done.");
}

seed().catch(e => { console.error(e); process.exit(1); });