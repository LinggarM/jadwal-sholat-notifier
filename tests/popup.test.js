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
  const sentMessages = [];
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
      Imsak: "04:10",
      Fajr: "04:30",
      Sunrise: "05:45",
      Dhuhr: "12:00",
      Asr: "15:00",
      Maghrib: "18:00",
      Isha: "20:00",
      Midnight: "00:00",
      Lastthird: "02:00"
    },
    previousTimings: { Isha: "20:00" },
    tomorrowTimings: { Fajr: "04:29" },
    preferences: {
      address: "Jakarta, Indonesia",
      method: 20,
      shafaq: "general",
      midnightMode: 0,
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
        sendMessage(message, callback) {
          sentMessages.push(message);
          callback({ ok: true, schedule, preferences: schedule.preferences });
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
  assert.equal(getElement("prayerTimes").children.length, 9);
  assert.equal(getElement("prayerTimes").children[2].children[0].textContent, "Terbit");
  assert.equal(getElement("prayerTimes").children[2].className, "sunrise");
  assert.equal(getElement("prayerTimes").children[0].children[0].textContent, "Imsak");
  assert.equal(getElement("prayerTimes").children[7].children[0].textContent, "Tengah malam");
  assert.equal(getElement("prayerTimes").children[8].children[0].textContent, "Sepertiga malam terakhir");
  assert.match(getElement("timeZone").textContent, /Asia\/Jakarta/);
  assert.equal(getElement("shafaqSetting").hidden, true);
  assert.equal(getElement("midnightModeInput").value, "0");

  getElement("methodInput").value = "15";
  getElement("methodInput").listeners.change();
  assert.equal(getElement("shafaqSetting").hidden, false);

  getElement("midnightModeInput").value = "1";
  getElement("saveBtn").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  const saveRequest = sentMessages.find(message => message.type === "savePreferences");
  assert.equal(saveRequest.preferences.midnightMode, 1);
});
