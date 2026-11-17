const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "prayer-utils.js"), "utf8"),
  context
);
const utils = context.PrayerUtils;

test("uses the requested location timezone for the current date", () => {
  const instant = new Date("2026-11-17T23:30:00Z");
  assert.equal(utils.dateKey(instant, "Asia/Jakarta"), "2026-11-18");
});

test("converts local prayer times to instants across UTC offsets", () => {
  assert.equal(
    utils.toInstant("2026-11-18", "04:30", "Asia/Jakarta").toISOString(),
    "2026-11-17T21:30:00.000Z"
  );
  assert.equal(
    utils.toInstant("2026-11-18", "04:30", "Asia/Kathmandu").toISOString(),
    "2026-11-17T22:45:00.000Z"
  );
});

test("converts times using the offset in effect on the requested date", () => {
  assert.equal(
    utils.toInstant("2026-03-08", "03:30", "America/New_York").toISOString(),
    "2026-03-08T07:30:00.000Z"
  );
});

test("formats API dates and rejects invalid prayer times", () => {
  assert.equal(utils.apiDate("2026-11-18"), "18-11-2026");
  assert.equal(utils.parseTime("04:32 (WIB)").hours, 4);
  assert.equal(utils.parseTime("25:00"), null);
});
