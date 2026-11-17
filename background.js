importScripts("prayer-utils.js");

const DEFAULT_PREFERENCES = {
  address: "Bekasi, Indonesia",
  method: 20,
  school: 0,
  notificationsEnabled: true,
  reminderMinutes: 0
};
const CALCULATION_METHODS = new Set([1, 2, 3, 4, 5, 20]);
const CACHE_DAYS = 3;
const REQUEST_TIMEOUT_MS = 12000;
const CATCH_UP_WINDOW_MS = 10 * 60 * 1000;
const PRAYER_ALARM_PREFIX = "prayer-notifier|event|";
const RETRY_ALARM_NAME = "prayer-notifier|retry";
const BASE_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const NOTIFICATION_ICON = "icon128.png";

function normalizePreferences(value) {
  const preferences = value || {};
  const method = Number(preferences.method);
  const school = Number(preferences.school);
  const reminderMinutes = Number(preferences.reminderMinutes);
  return {
    address: typeof preferences.address === "string" ? preferences.address.trim() : DEFAULT_PREFERENCES.address,
    method: CALCULATION_METHODS.has(method) ? method : DEFAULT_PREFERENCES.method,
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
    cache.school === preferences.school &&
    typeof cache.timeZone === "string" &&
    cache.dates;
}

async function fetchTimings(address, dateKey, preferences) {
  const params = new URLSearchParams({
    address,
    method: String(preferences.method),
    school: String(preferences.school)
  });
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
  return schedule;
}

function respondWith(promise, sendResponse, reportError) {
  promise
    .then(sendResponse)
    .catch(error => {
      console.error(reportError, error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  refreshAndSchedule(false).catch(error => console.error("Gagal menyiapkan jadwal sholat:", error));
});

chrome.runtime.onStartup.addListener(() => {
  refreshAndSchedule(false).catch(error => console.error("Gagal memulihkan jadwal sholat:", error));
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RETRY_ALARM_NAME || alarm.name.startsWith(PRAYER_ALARM_PREFIX)) {
    refreshAndSchedule(false).catch(error => console.error("Gagal memeriksa alarm sholat:", error));
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
          return { ok: true, preferences, schedule: null, warning: error.message };
        }
      }),
      sendResponse,
      "Gagal menyimpan pengaturan:"
    );
  }

  return false;
});
