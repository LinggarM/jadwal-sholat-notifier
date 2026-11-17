const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeElement {
  constructor() {
    this.style = {};
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.value = "";
    this.textContent = "";
    this.checked = false;
    this.disabled = false;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  append(...elements) {
    this.children.push(...elements);
  }

  replaceChildren(...elements) {
    this.children = [...elements];
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

test("renders countdown and prayer list in the location timezone", async () => {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) {
      elements.set(id, new FakeElement());
    }
    return elements.get(id);
  };
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [Date.parse("2026-11-17T23:30:00Z")]));
    }

    static now() {
      return Date.parse("2026-11-17T23:30:00Z");
    }
  }
  const schedule = {
    date: "2026-11-18",
    tomorrowDate: "2026-11-19",
    timeZone: "Asia/Jakarta",
    address: "Jakarta, Indonesia",
    timings: {
      Fajr: "04:30",
      Dhuhr: "12:00",
      Asr: "15:00",
      Maghrib: "18:00",
      Isha: "20:00"
    },
    previousTimings: { Isha: "20:00" },
    tomorrowTimings: { Fajr: "04:29" },
    preferences: {
      address: "Jakarta, Indonesia",
      method: 20,
      school: 0,
      notificationsEnabled: true,
      reminderMinutes: 0
    },
    stale: false
  };
  const context = vm.createContext({
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(_message, callback) {
          callback({ ok: true, schedule });
        }
      }
    },
    console,
    Date: FixedDate,
    document: {
      getElementById: getElement,
      querySelector: getElement,
      createElement: () => new FakeElement()
    },
    setInterval: () => 1
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "prayer-utils.js"), "utf8"),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8"),
    context
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(getElement("countdown").textContent, "05:30:00");
  assert.equal(getElement("nextPrayer").textContent, "Menuju waktu sholat Zuhur");
  assert.equal(getElement("prayerTimes").children.length, 5);
  assert.match(getElement("timeZone").textContent, /Asia\/Jakarta/);
});
