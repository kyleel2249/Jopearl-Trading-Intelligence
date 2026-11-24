import test from "node:test";
import assert from "node:assert/strict";
import { resolvePrecision, roundToTick, formatInstrumentPrice, priceDistanceInPips, pricePrecisionDiagnostics } from "./precision.js";

test("tick-size calibration overrides decimal precision", () => {
  assert.equal(roundToTick(1.23456, { tickSize: 0.0001 }), 1.2346);
  assert.equal(roundToTick(1.23454, { tickSize: 0.0001 }), 1.2345);
});
test("JPY-style pip distance and fractional pip rounding", () => {
  assert.equal(priceDistanceInPips(150.125, 150.225, { pipSize: 0.01, tickSize: 0.001 }), 10);
  assert.equal(roundToTick(150.1234, { tickSize: 0.001 }), 150.123);
});
test("crypto arbitrary tick increments and precision fallback", () => {
  assert.equal(roundToTick(123.4567, { tickSize: 0.05 }), 123.45);
  assert.equal(roundToTick(2.123456, { priceDecimals: 4 }), 2.1235);
});
test("invalid prices return null; unresolved precision does not fabricate digits", () => {
  assert.equal(roundToTick(NaN, { tickSize: 0.01 }), null);
  assert.equal(resolvePrecision({}).calibrated, false);
  assert.equal(priceDistanceInPips(1, 2, {}), null);
});
test("diagnostics surface missing metadata instead of silently assuming it", () => {
  const d = pricePrecisionDiagnostics({ symbol: "TEST" });
  assert.equal(d.source, "unresolved");
  assert.equal(d.warnings.length, 2);
});
test("formatting honors tick precision and preserves instrument decimals", () => {
  assert.equal(formatInstrumentPrice(1.23456, { tickSize: 0.0001 }), "1.2346");
  assert.equal(formatInstrumentPrice(1, { tickSize: 0.01 }), "1.00");
  assert.equal(formatInstrumentPrice(1.23456789, {}, { maximumFractionDigits: 3 }), "1.235");
});
