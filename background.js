const DEFAULT_ADDRESS = "Bekasi, Indonesia";
const PRAYERS = [
  { key: "Fajr", name: "Subuh" },
  { key: "Dhuhr", name: "Zuhur" },
  { key: "Asr", name: "Asar" },
  { key: "Maghrib", name: "Magrib" },
  { key: "Isha", name: "Isya" }
];

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function apiDate(date) {
  return `${String(date.getDate()).padStart(2, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${date.getFullYear()}`;
}

async function fetchTimings(address, date) {
  const params = new URLSearchParams({
    address,
    method: "20",
    school: "0"
  });
  const response = await fetch(`https://api.aladhan.com/v1/timingsByAddress/${apiDate(date)}?${params}`);
  if (!response.ok) {
    throw new Error(`Layanan jadwal merespons HTTP ${response.status}`);
  }

  const result = await response.json();
  if (result.code !== 200 || !result.data || !result.data.timings) {
    throw new Error("Layanan jadwal tidak mengembalikan data yang valid");
  }
  return result.data.timings;
}

async function loadSchedule(forceRefresh) {
  const today = new Date();
  const todayKey = dateKey(today);
  const stored = await chrome.storage.local.get(["address", "scheduleDate", "timings", "tomorrowTimings"]);
  const address = (stored.address || DEFAULT_ADDRESS).trim();

  if (!address) {
    throw new Error("Lokasi belum diisi");
  }
  if (!forceRefresh && stored.scheduleDate === todayKey && stored.timings) {
    return {
      address,
      scheduleDate: stored.scheduleDate,
      timings: stored.timings,
      tomorrowTimings: stored.tomorrowTimings
    };
  }

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [timings, tomorrowTimings] = await Promise.all([
    fetchTimings(address, today),
    fetchTimings(address, tomorrow)
  ]);
  const schedule = {
    address,
    scheduleDate: todayKey,
    timings,
    tomorrowTimings
  };
  await chrome.storage.local.set(schedule);
  return schedule;
}

async function checkPrayerTime() {
  const schedule = await loadSchedule(false);
  const now = new Date();
  const prayer = PRAYERS.find(item => {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(schedule.timings[item.key] || ""));
    if (!match) {
      return false;
    }
    const prayerTime = new Date(now);
    prayerTime.setHours(Number(match[1]), Number(match[2]), 0, 0);
    const elapsed = now - prayerTime;
    return elapsed >= 0 && elapsed < 2 * 60 * 1000;
  });
  if (!prayer) {
    return;
  }

  const notificationKey = `${schedule.scheduleDate}-${prayer.key}`;
  const { lastNotification } = await chrome.storage.local.get("lastNotification");
  if (lastNotification === notificationKey) {
    return;
  }

  await chrome.storage.local.set({ lastNotification: notificationKey });
  await chrome.notifications.create(notificationKey, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: `Waktu Sholat ${prayer.name}`,
    message: `Saatnya menunaikan sholat ${prayer.name}.`,
    priority: 2
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("checkPrayerTime", { periodInMinutes: 1 });
  loadSchedule(false).catch(error => console.error("Gagal memuat jadwal sholat:", error));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("checkPrayerTime", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "checkPrayerTime") {
    checkPrayerTime().catch(error => console.error("Gagal memeriksa waktu sholat:", error));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "getSchedule") {
    return false;
  }

  loadSchedule(Boolean(message.force))
    .then(schedule => sendResponse({ ok: true, schedule }))
    .catch(error => {
      console.error("Gagal memperbarui jadwal sholat:", error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});
