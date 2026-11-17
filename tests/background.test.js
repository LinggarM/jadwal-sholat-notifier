const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createEvent() {
  return {
    listener: null,
    addListener(listener) {
      this.listener = listener;
    }
  };
}

function createHarness() {
  const now = Date.parse("2026-11-17T23:30:00Z");
  const state = {};
  const alarms = new Map();
  const notifications = [];
  const requestedUrls = [];
  const actionState = {};
  let fetchFails = false;
  const runtime = {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: createEvent(),
    getURL: file => `chrome-extension://test/${file}`
  };
  const action = {
    async setBadgeText({ text }) {
      actionState.badgeText = text;
    },
    async setBadgeBackgroundColor({ color }) {
      actionState.badgeColor = color;
    },
    async setTitle({ title }) {
      actionState.title = title;
    },
    async setIcon({ imageData, path }) {
      actionState.icon = imageData || path;
    }
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") {
            return { [keys]: state[keys] };
          }
          return Object.fromEntries(keys.map(key => [key, state[key]]));
        },
        async set(values) {
          Object.assign(state, values);
        }
      }
    },
    alarms: {
      getAll: async () => Array.from(alarms, ([name, alarm]) => ({ name, ...alarm })),
      async create(name, info) {
        alarms.set(name, info);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: createEvent()
    },
    notifications: {
      async create(id, options) {
        notifications.push({ id, options });
      }
    },
    action,
    runtime
  };
  class MockOffscreenCanvas {
    getContext() {
      const fills = [];
      return {
        arc() {},
        beginPath() {},
        clearRect() {},
        fill() {},
        fillRect(...args) {
          fills.push(args);
        },
        getImageData() {
          return { fills };
        },
        set fillStyle(_value) {}
      };
    }
  }
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }
  const context = vm.createContext({
    AbortController,
    chrome,
    clearTimeout,
    console,
    Date: FixedDate,
    OffscreenCanvas: MockOffscreenCanvas,
    fetch: async url => {
      requestedUrls.push(url);
      if (fetchFails) {
        return { ok: false, status: 503 };
      }
      return {
        ok: true,
        async json() {
          return {
            code: 200,
            data: {
              meta: { timezone: "Asia/Jakarta" },
              timings: {
                Imsak: "04:10",
                Fajr: "06:25",
                Sunrise: "05:45",
                Dhuhr: "12:00",
                Asr: "15:00",
                Maghrib: "18:00",
                Isha: "20:00",
                Midnight: "00:00",
                Lastthird: "02:00"
              }
            }
          };
        }
      };
    },
    setTimeout,
    URLSearchParams
  });
  const utilities = fs.readFileSync(path.join(__dirname, "..", "prayer-utils.js"), "utf8");
  context.importScripts = () => vm.runInContext(utilities, context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"),
    context
  );

  function sendMessage(message) {
    return new Promise(resolve => {
      runtime.onMessage.listener(message, {}, resolve);
    });
  }

  return {
    alarms,
    actionState,
    chrome,
    notifications,
    requestedUrls,
    sendMessage,
    setFetchFailure(value) {
      fetchFails = value;
    },
    state
  };
}

test("loads location-local dates, caches schedules, and catches up once", async () => {
  const harness = createHarness();
  const first = await harness.sendMessage({ type: "getSchedule" });

  assert.equal(first.ok, true);
  assert.equal(first.schedule.date, "2026-11-18");
  assert.equal(first.schedule.timeZone, "Asia/Jakarta");
  assert.equal(first.schedule.stale, false);
  assert(harness.requestedUrls.some(url => url.includes("/18-11-2026?")));
  assert(harness.requestedUrls.some(url => url.includes("/19-11-2026?")));
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].options.title, "Waktu Sholat Subuh");
  assert(harness.alarms.size > 0);
  assert.equal(harness.actionState.badgeText, "5:30");
  assert.match(harness.actionState.title, /Zuhur dalam 05:30:00/);
  assert.equal(harness.actionState.icon.fills.length, 2);

  const requestCount = harness.requestedUrls.length;
  const second = await harness.sendMessage({ type: "getSchedule" });
  assert.equal(second.ok, true);
  assert.equal(harness.requestedUrls.length, requestCount);
  assert.equal(harness.notifications.length, 1);
});

test("installs a recurring alarm to refresh the pinned toolbar countdown", async () => {
  const harness = createHarness();
  harness.chrome.runtime.onInstalled.listener();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(harness.alarms.get("prayer-notifier|toolbar").periodInMinutes, 1);
  assert.match(harness.actionState.title, /dalam/);
});

test("saves settings and refreshes the schedule for the selected method and school", async () => {
  const harness = createHarness();
  const response = await harness.sendMessage({
    type: "savePreferences",
    preferences: {
      address: "Jakarta, Indonesia",
      method: 3,
      midnightMode: 0,
      school: 1,
      notificationsEnabled: true,
      reminderMinutes: 15
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.preferences.method, 3);
  assert.equal(response.preferences.midnightMode, 0);
  assert.equal(response.preferences.school, 1);
  assert.equal(response.preferences.reminderMinutes, 15);
  assert(harness.requestedUrls.every(url => url.includes("method=3") && url.includes("midnightMode=0") && url.includes("school=1")));
  assert(harness.requestedUrls.every(url => !url.includes("shafaq=")));
  assert(harness.alarms.size > 0);
});

test("sends the required shafaq option for Moonsighting method 15", async () => {
  const harness = createHarness();
  const response = await harness.sendMessage({
    type: "savePreferences",
    preferences: {
      address: "Jakarta, Indonesia",
      method: 15,
      shafaq: "abyad",
      midnightMode: 0,
      school: 0,
      notificationsEnabled: true,
      reminderMinutes: 0
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.preferences.shafaq, "abyad");
  assert(harness.requestedUrls.every(url => url.includes("method=15") && url.includes("shafaq=abyad")));

  const previousRequestCount = harness.requestedUrls.length;
  const updated = await harness.sendMessage({
    type: "savePreferences",
    preferences: {
      address: "Jakarta, Indonesia",
      method: 15,
      shafaq: "ahmer",
      midnightMode: 0,
      school: 0,
      notificationsEnabled: true,
      reminderMinutes: 0
    }
  });
  assert.equal(updated.ok, true);
  assert(harness.requestedUrls.slice(previousRequestCount).every(url => url.includes("shafaq=ahmer")));
  assert.equal(harness.state.scheduleCache.shafaq, "ahmer");
});

test("sends and caches the selected midnight calculation mode", async () => {
  const harness = createHarness();
  await harness.sendMessage({
    type: "savePreferences",
    preferences: {
      address: "Jakarta, Indonesia",
      method: 20,
      shafaq: "general",
      midnightMode: 0,
      school: 0,
      notificationsEnabled: true,
      reminderMinutes: 0
    }
  });
  const previousRequestCount = harness.requestedUrls.length;

  const updated = await harness.sendMessage({
    type: "savePreferences",
    preferences: {
      address: "Jakarta, Indonesia",
      method: 20,
      shafaq: "general",
      midnightMode: 1,
      school: 0,
      notificationsEnabled: true,
      reminderMinutes: 0
    }
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.preferences.midnightMode, 1);
  assert(harness.requestedUrls.slice(previousRequestCount).every(url => url.includes("midnightMode=1")));
  assert.equal(harness.state.scheduleCache.midnightMode, 1);
});

test("rejects invalid settings without requesting a schedule", async () => {
  const harness = createHarness();
  const response = await harness.sendMessage({
    type: "savePreferences",
    preferences: {
      address: "Jakarta, Indonesia",
      method: 6,
      school: 0,
      notificationsEnabled: true,
      reminderMinutes: 0
    }
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /Metode perhitungan tidak valid/);
  assert.equal(harness.requestedUrls.length, 0);
});

test("rejects unsupported midnight calculation modes", async () => {
  const harness = createHarness();
  const response = await harness.sendMessage({
    type: "savePreferences",
    preferences: {
      address: "Jakarta, Indonesia",
      method: 20,
      midnightMode: 2,
      school: 0,
      notificationsEnabled: true,
      reminderMinutes: 0
    }
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /Mode perhitungan tengah malam tidak valid/);
  assert.equal(harness.requestedUrls.length, 0);
});

test("keeps a usable cached schedule and reports it as stale when the API fails", async () => {
  const harness = createHarness();
  const initial = await harness.sendMessage({ type: "getSchedule" });
  assert.equal(initial.ok, true);

  harness.setFetchFailure(true);
  const refreshed = await harness.sendMessage({ type: "getSchedule", force: true });

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.schedule.stale, true);
  assert.match(refreshed.schedule.error, /HTTP 503/);
  assert.equal(refreshed.schedule.date, "2026-11-18");
  assert.equal(harness.state.scheduleRetry.attempt, 1);
  assert.equal(
    harness.alarms.get("prayer-notifier|retry").when - Date.parse("2026-11-17T23:30:00Z"),
    60000
  );

  const requestCount = harness.requestedUrls.length;
  const backedOff = await harness.sendMessage({ type: "getSchedule" });
  assert.equal(backedOff.schedule.stale, true);
  assert.equal(harness.requestedUrls.length, requestCount);

  await harness.sendMessage({ type: "getSchedule", force: true });
  assert.equal(harness.state.scheduleRetry.attempt, 2);
  assert.equal(
    harness.alarms.get("prayer-notifier|retry").when - Date.parse("2026-11-17T23:30:00Z"),
    120000
  );
});
