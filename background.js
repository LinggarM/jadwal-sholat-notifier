importScripts("prayer-utils.js");

const DEFAULT_PREFERENCES = {
  address: "Bekasi, Indonesia",
  method: 20,
  shafaq: "general",
  midnightMode: 0,
  school: 0,
  notificationsEnabled: true,
  reminderMinutes: 0
};
const CALCULATION_METHODS = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
const SHAFAQ_OPTIONS = new Set(["general", "ahmer", "abyad"]);
const CACHE_DAYS = 3;
const REQUEST_TIMEOUT_MS = 12000;
const CATCH_UP_WINDOW_MS = 10 * 60 * 1000;
const PRAYER_ALARM_PREFIX = "prayer-notifier|event|";
const RETRY_ALARM_NAME = "prayer-notifier|retry";
const BASE_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const NOTIFICATION_ICON = "icon128.png";
const TOOLBAR_ALARM_NAME = "prayer-notifier|toolbar";

function normalizePreferences(value) {
  const preferences = value || {};
  const method = Number(preferences.method);
  const midnightMode = Number(preferences.midnightMode);
  const school = Number(preferences.school);
  const reminderMinutes = Number(preferences.reminderMinutes);
  return {
    address: typeof preferences.address === "string" ? preferences.address.trim() : DEFAULT_PREFERENCES.address,
    method: CALCULATION_METHODS.has(method) ? method : DEFAULT_PREFERENCES.method,
    shafaq: SHAFAQ_OPTIONS.has(preferences.shafaq) ? preferences.shafaq : DEFAULT_PREFERENCES.shafaq,
    midnightMode: midnightMode === 1 ? 1 : 0,
    school: school === 1 ? 1 : 0,
    notificationsEnabled: preferences.notificationsEnabled !== false,
    reminderMinutes: [0, 5, 10, 15].includes(reminderMinutes) ? reminderMinutes : 0
  };
}

function validatePreferences(value) {
  if (!value || typeof value.address !== "string" || !value.address.trim() || value.address.trim().length > 200) {
    throw new Error("Lokasi wajib diisi dan maksimal 200 karakter");
  }
  if (!CALCULATION_METHODS.has(Number(value.method))) {
    throw new Error("Metode perhitungan tidak valid");
  }
  if (!SHAFAQ_OPTIONS.has(value.shafaq || DEFAULT_PREFERENCES.shafaq)) {
    throw new Error("Pilihan shafaq tidak valid");
  }
  if (![0, 1].includes(value.midnightMode === undefined ? DEFAULT_PREFERENCES.midnightMode : Number(value.midnightMode))) {
    throw new Error("Mode perhitungan tengah malam tidak valid");
  }
  if (![0, 1].includes(Number(value.school))) {
    throw new Error("Mazhab untuk waktu Asar tidak valid");
  }
  if (typeof value.notificationsEnabled !== "boolean") {
    throw new Error("Pilihan notifikasi tidak valid");
  }
  if (![0, 5, 10, 15].includes(Number(value.reminderMinutes))) {
    throw new Error("Durasi pengingat tidak valid");
  }
  return normalizePreferences(value);
}

async function getPreferences() {
  const stored = await chrome.storage.local.get(["preferences", "address"]);
  const legacyPreferences = stored.preferences || {
    ...DEFAULT_PREFERENCES,
    address: stored.address || DEFAULT_PREFERENCES.address
  };
  return normalizePreferences(legacyPreferences);
}

function cacheMatches(cache, preferences) {
  return cache &&
    cache.address === preferences.address &&
    cache.method === preferences.method &&
    cache.shafaq === preferences.shafaq &&
    cache.midnightMode === preferences.midnightMode &&
    cache.school === preferences.school &&
    typeof cache.timeZone === "string" &&
    cache.dates;
}

async function fetchTimings(address, dateKey, preferences) {
  const params = new URLSearchParams({
    address,
    method: String(preferences.method),
    midnightMode: String(preferences.midnightMode),
    school: String(preferences.school)
  });
  if (preferences.method === 15) {
    params.set("shafaq", preferences.shafaq);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.aladhan.com/v1/timingsByAddress/${PrayerUtils.apiDate(dateKey)}?${params}`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      throw new Error(`Layanan jadwal merespons HTTP ${response.status}`);
    }

    const result = await response.json();
    const timings = result && result.data && result.data.timings;
    const timeZone = result && result.data && result.data.meta && result.data.meta.timezone;
    if (result.code !== 200 || !timings || !timeZone) {
      throw new Error("Layanan jadwal tidak mengembalikan waktu atau zona waktu yang valid");
    }

    PrayerUtils.dateKey(new Date(), timeZone);
    for (const prayer of PrayerUtils.PRAYERS) {
      if (!PrayerUtils.parseTime(timings[prayer.key])) {
        throw new Error(`Waktu ${prayer.name} tidak valid`);
      }
    }
    if (!PrayerUtils.parseTime(timings.Sunrise)) {
      throw new Error("Waktu terbit tidak valid");
    }
    return { timings, timeZone };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Permintaan jadwal melewati batas waktu 12 detik");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function createSchedule(preferences, cache, todayKey, stale, error) {
  const yesterdayKey = PrayerUtils.addDays(todayKey, -1);
  const tomorrowKey = PrayerUtils.addDays(todayKey, 1);
  return {
    address: preferences.address,
    method: preferences.method,
    shafaq: preferences.shafaq,
    midnightMode: preferences.midnightMode,
    school: preferences.school,
    date: todayKey,
    timeZone: cache.timeZone,
    previousTimings: cache.dates[yesterdayKey] || null,
    timings: cache.dates[todayKey],
    tomorrowDate: tomorrowKey,
    tomorrowTimings: cache.dates[tomorrowKey] || null,
    stale,
    error: error || null,
    preferences
  };
}

async function loadSchedule(forceRefresh) {
  const preferences = await getPreferences();
  if (!preferences.address) {
    throw new Error("Masukkan lokasi sebelum memuat jadwal");
  }

  const stored = await chrome.storage.local.get("scheduleCache");
  const retryStateResult = await chrome.storage.local.get("scheduleRetry");
  const retryState = retryStateResult.scheduleRetry || { attempt: 0, nextAt: 0 };
  let cache = cacheMatches(stored.scheduleCache, preferences) ? stored.scheduleCache : null;
  let todayKey = cache
    ? PrayerUtils.dateKey(new Date(), cache.timeZone)
    : PrayerUtils.dateKey(new Date());
  let tomorrowKey = PrayerUtils.addDays(todayKey, 1);

  if (!forceRefresh && cache && cache.dates[todayKey] && cache.dates[tomorrowKey]) {
    if (retryState.attempt > 0) {
      if (retryState.nextAt > Date.now()) {
        return createSchedule(
          preferences,
          cache,
          todayKey,
          true,
          retryState.lastError || "Pembaruan ulang sedang menunggu jeda percobaan"
        );
      }
    } else {
      return createSchedule(preferences, cache, todayKey, false);
    }
  } else if (!forceRefresh && retryState.attempt > 0 && retryState.nextAt > Date.now()) {
    throw new Error("Jadwal belum tersedia; percobaan ulang otomatis sudah dijadwalkan");
  }

  try {
    let [todayResult, tomorrowResult] = await Promise.all([
      fetchTimings(preferences.address, todayKey, preferences),
      fetchTimings(preferences.address, tomorrowKey, preferences)
    ]);

    if (todayResult.timeZone !== tomorrowResult.timeZone) {
      throw new Error("Zona waktu hasil jadwal tidak konsisten");
    }
    const locationToday = PrayerUtils.dateKey(new Date(), todayResult.timeZone);
    if (locationToday !== todayKey) {
      todayKey = locationToday;
      tomorrowKey = PrayerUtils.addDays(todayKey, 1);
      [todayResult, tomorrowResult] = await Promise.all([
        fetchTimings(preferences.address, todayKey, preferences),
        fetchTimings(preferences.address, tomorrowKey, preferences)
      ]);
      if (todayResult.timeZone !== tomorrowResult.timeZone) {
        throw new Error("Zona waktu hasil jadwal tidak konsisten");
      }
    }

    const dates = cache && cache.timeZone === todayResult.timeZone ? { ...cache.dates } : {};
    dates[todayKey] = todayResult.timings;
    dates[tomorrowKey] = tomorrowResult.timings;
    const oldestDate = PrayerUtils.addDays(todayKey, -(CACHE_DAYS - 2));
    for (const date of Object.keys(dates)) {
      if (date < oldestDate || date > tomorrowKey) {
        delete dates[date];
      }
    }

    cache = {
      address: preferences.address,
      method: preferences.method,
      shafaq: preferences.shafaq,
      midnightMode: preferences.midnightMode,
      school: preferences.school,
      timeZone: todayResult.timeZone,
      dates,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ scheduleCache: cache });
    await clearRetryAlarm();
    return createSchedule(preferences, cache, todayKey, false);
  } catch (error) {
    await scheduleRetry(error);
    if (cache && cache.dates[todayKey]) {
      console.error("Menggunakan jadwal tersimpan karena pembaruan gagal:", error);
      return createSchedule(preferences, cache, todayKey, true, error.message);
    }
    throw error;
  }
}

function notificationKey(date, prayerKey, kind) {
  return `${date}|${prayerKey}|${kind}`;
}

async function processDueNotifications(schedule) {
  const preferences = schedule.preferences;
  if (!preferences.notificationsEnabled) {
    return;
  }

  const now = Date.now();
  const dates = [schedule.date, schedule.tomorrowDate];
  const stored = await chrome.storage.local.get("processedNotifications");
  const processed = stored.processedNotifications || {};

  for (const date of dates) {
    const timings = date === schedule.date ? schedule.timings : schedule.tomorrowTimings;
    if (!timings) {
      continue;
    }

    for (const prayer of PrayerUtils.PRAYERS) {
      const prayerTime = PrayerUtils.toInstant(date, timings[prayer.key], schedule.timeZone);
      if (!prayerTime) {
        continue;
      }

      const events = [{ kind: "prayer", when: prayerTime.getTime() }];
      if (preferences.reminderMinutes > 0) {
        events.push({
          kind: "reminder",
          when: prayerTime.getTime() - preferences.reminderMinutes * 60 * 1000
        });
      }

      for (const event of events) {
        const key = notificationKey(date, prayer.key, event.kind);
        const age = now - event.when;
        if (processed[key] || age < 0 || age > CATCH_UP_WINDOW_MS) {
          continue;
        }

        const title = event.kind === "reminder"
          ? `Pengingat: ${prayer.name}`
          : `Waktu Sholat ${prayer.name}`;
        const message = event.kind === "reminder"
          ? `Sholat ${prayer.name} akan tiba dalam ${preferences.reminderMinutes} menit.`
          : `Saatnya menunaikan sholat ${prayer.name}.`;
        try {
          await chrome.notifications.create(key, {
            type: "basic",
            iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
            title,
            message,
            priority: 2
          });
        } catch (error) {
          console.error(`Gagal menampilkan notifikasi ${key}:`, error);
        }
        processed[key] = Date.now();
        await chrome.storage.local.set({ processedNotifications: processed });
      }
    }
  }

  const minimumDate = PrayerUtils.addDays(schedule.date, -2);
  for (const key of Object.keys(processed)) {
    if (key.split("|")[0] < minimumDate) {
      delete processed[key];
    }
  }
  await chrome.storage.local.set({ processedNotifications: processed });
}

async function schedulePrayerAlarms(schedule) {
  await clearPrayerAlarms();
  if (!schedule.preferences.notificationsEnabled) {
    return;
  }

  const now = Date.now();
  for (const date of [schedule.date, schedule.tomorrowDate]) {
    const timings = date === schedule.date ? schedule.timings : schedule.tomorrowTimings;
    if (!timings) {
      continue;
    }
    for (const prayer of PrayerUtils.PRAYERS) {
      const prayerTime = PrayerUtils.toInstant(date, timings[prayer.key], schedule.timeZone);
      if (!prayerTime) {
        continue;
      }
      const prayerWhen = prayerTime.getTime();
      const alarmEvents = [{ kind: "prayer", when: prayerWhen }];
      if (schedule.preferences.reminderMinutes > 0) {
        alarmEvents.push({
          kind: "reminder",
          when: prayerWhen - schedule.preferences.reminderMinutes * 60 * 1000
        });
      }
      for (const event of alarmEvents) {
        if (event.when > now) {
          const name = `${PRAYER_ALARM_PREFIX}${event.kind}|${date}|${prayer.key}`;
          await chrome.alarms.create(name, { when: event.when });
        }
      }
    }
  }
}

async function clearPrayerAlarms() {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name.startsWith(PRAYER_ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }
}

async function scheduleRetry(error) {
  const stored = await chrome.storage.local.get("scheduleRetry");
  const attempt = (stored.scheduleRetry && stored.scheduleRetry.attempt || 0) + 1;
  const delay = Math.min(BASE_RETRY_DELAY_MS * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
  const nextAt = Date.now() + delay;
  await chrome.storage.local.set({
    scheduleRetry: { attempt, nextAt, lastError: error.message }
  });
  await chrome.alarms.create(RETRY_ALARM_NAME, { when: nextAt });
}

async function clearRetryAlarm() {
  await chrome.alarms.clear(RETRY_ALARM_NAME);
  await chrome.storage.local.set({
    scheduleRetry: { attempt: 0, nextAt: 0, lastError: null }
  });
}

async function refreshAndSchedule(forceRefresh) {
  const schedule = await loadSchedule(forceRefresh);
  if (!schedule.stale) {
    await clearRetryAlarm();
  }
  await processDueNotifications(schedule);
  await schedulePrayerAlarms(schedule);
  await updateAction(schedule);
  return schedule;
}

function formatBadgeCountdown(remainingMs) {
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 10) {
    return `${hours}h`;
  }
  return `${hours}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function formatFullCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

async function updateProgressIcon(percentage) {
  const canvas = new OffscreenCanvas(32, 32);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Tidak dapat membuat kanvas ikon ekstensi");
  }

  context.clearRect(0, 0, 32, 32);
  context.fillStyle = "#166534";
  context.beginPath();
  context.arc(16, 16, 15, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(14, 16, 8, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#166534";
  context.beginPath();
  context.arc(18, 13, 8, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#d1d5db";
  context.fillRect(2, 4, 3, 24);
  context.fillStyle = "#facc15";
  const progressHeight = 24 * Math.max(0, Math.min(100, percentage)) / 100;
  context.fillRect(2, 28 - progressHeight, 3, progressHeight);
  await chrome.action.setIcon({
    imageData: context.getImageData(0, 0, 32, 32)
  });
}

async function updateAction(schedule) {
  const progress = PrayerUtils.getPrayerProgress(schedule, new Date());
  await chrome.action.setBadgeBackgroundColor({ color: "#166534" });
  if (!progress) {
    await chrome.action.setBadgeText({ text: "--" });
    await chrome.action.setTitle({ title: "Jadwal Sholat — jadwal berikutnya belum tersedia" });
    try {
      await updateProgressIcon(0);
    } catch (error) {
      console.error("Gagal menggambar progress ikon toolbar:", error);
    }
    return;
  }

  const countdown = formatFullCountdown(progress.remainingMs);
  const stalePrefix = schedule.stale ? "Data jadwal lama. " : "";
  await chrome.action.setBadgeText({ text: formatBadgeCountdown(progress.remainingMs) });
  await chrome.action.setTitle({
    title: `${stalePrefix}${progress.next.name} dalam ${countdown} — progres ${Math.round(progress.percentage)}%`
  });
  try {
    await updateProgressIcon(progress.percentage);
  } catch (error) {
    console.error("Gagal menggambar progress ikon toolbar:", error);
    await chrome.action.setIcon({ path: NOTIFICATION_ICON });
  }
}

async function updateActionFromCurrentSchedule() {
  const schedule = await loadSchedule(false);
  await processDueNotifications(schedule);
  await updateAction(schedule);
}

async function showActionError(error) {
  await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title: `Jadwal Sholat — ${error.message}` });
}

function ensureToolbarAlarm() {
  chrome.alarms.create(TOOLBAR_ALARM_NAME, { periodInMinutes: 1 });
}

function respondWith(promise, sendResponse, reportError) {
  promise
    .then(sendResponse)
    .catch(error => {
      console.error(reportError, error);
      showActionError(error).catch(actionError => console.error("Gagal menampilkan status error toolbar:", actionError));
      sendResponse({ ok: false, error: error.message });
    });
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureToolbarAlarm();
  refreshAndSchedule(false).catch(error => {
    console.error("Gagal menyiapkan jadwal sholat:", error);
    showActionError(error).catch(actionError => console.error("Gagal menampilkan status error toolbar:", actionError));
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureToolbarAlarm();
  refreshAndSchedule(false).catch(error => {
    console.error("Gagal memulihkan jadwal sholat:", error);
    showActionError(error).catch(actionError => console.error("Gagal menampilkan status error toolbar:", actionError));
  });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TOOLBAR_ALARM_NAME) {
    updateActionFromCurrentSchedule().catch(error => {
      console.error("Gagal memperbarui countdown toolbar:", error);
      showActionError(error).catch(actionError => console.error("Gagal menampilkan status error toolbar:", actionError));
    });
  } else if (alarm.name === RETRY_ALARM_NAME || alarm.name.startsWith(PRAYER_ALARM_PREFIX)) {
    refreshAndSchedule(false).catch(error => {
      console.error("Gagal memeriksa alarm sholat:", error);
      showActionError(error).catch(actionError => console.error("Gagal menampilkan status error toolbar:", actionError));
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "getSchedule") {
    return respondWith(
      refreshAndSchedule(Boolean(message.force)).then(schedule => ({ ok: true, schedule })),
      sendResponse,
      "Gagal memuat jadwal sholat:"
    );
  }

  if (message && message.type === "savePreferences") {
    let preferences;
    try {
      preferences = validatePreferences(message.preferences);
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
      return false;
    }

    return respondWith(
      chrome.storage.local.set({ preferences }).then(async () => {
        await clearPrayerAlarms();
        await clearRetryAlarm();
        try {
          const schedule = await refreshAndSchedule(true);
          return { ok: true, preferences, schedule };
        } catch (error) {
          console.error("Pengaturan tersimpan, tetapi jadwal belum dapat diperbarui:", error);
          await showActionError(error);
          return { ok: true, preferences, schedule: null, warning: error.message };
        }
      }),
      sendResponse,
      "Gagal menyimpan pengaturan:"
    );
  }

  return false;
});
