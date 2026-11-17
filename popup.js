const DEFAULT_PREFERENCES = {
  address: "Bekasi, Indonesia",
  method: 20,
  school: 0,
  notificationsEnabled: true,
  reminderMinutes: 0
};

const countdownElement = document.getElementById("countdown");
const nextPrayerElement = document.getElementById("nextPrayer");
const batteryBar = document.getElementById("batteryBar");
const batteryContainer = document.querySelector(".battery-container");
const addressInput = document.getElementById("addressInput");
const methodInput = document.getElementById("methodInput");
const schoolInput = document.getElementById("schoolInput");
const notificationsInput = document.getElementById("notificationsInput");
const reminderInput = document.getElementById("reminderInput");
const saveButton = document.getElementById("saveBtn");
const refreshButton = document.getElementById("refreshBtn");
const statusElement = document.getElementById("status");
const timeZoneElement = document.getElementById("timeZone");
const prayerTimesElement = document.getElementById("prayerTimes");
let schedule = null;
let nextScheduleAttempt = 0;

function getPreferencesFromForm() {
  return {
    address: addressInput.value.trim(),
    method: Number(methodInput.value),
    school: Number(schoolInput.value),
    notificationsEnabled: notificationsInput.checked,
    reminderMinutes: Number(reminderInput.value)
  };
}

function applyPreferences(preferences) {
  addressInput.value = preferences.address || DEFAULT_PREFERENCES.address;
  methodInput.value = String(preferences.method);
  schoolInput.value = String(preferences.school);
  notificationsInput.checked = preferences.notificationsEnabled;
  reminderInput.value = String(preferences.reminderMinutes);
  reminderInput.disabled = !preferences.notificationsEnabled;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response || !response.ok) {
        reject(new Error(response && response.error ? response.error : "Permintaan tidak dapat diproses"));
      } else {
        resolve(response);
      }
    });
  });
}

function renderPrayerTimes() {
  prayerTimesElement.replaceChildren();
  if (!schedule) {
    return;
  }
  for (const prayer of PrayerUtils.PRAYERS) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const time = document.createElement("time");
    name.textContent = prayer.name;
    time.textContent = String(schedule.timings[prayer.key] || "--:--").slice(0, 5);
    item.append(name, time);
    prayerTimesElement.append(item);
  }
}

function updateCountdown() {
  const now = new Date();
  const today = schedule ? PrayerUtils.dateKey(now, schedule.timeZone) : null;
  if (!schedule || schedule.date !== today) {
    countdownElement.textContent = "--:--:--";
    nextPrayerElement.textContent = "Memuat jadwal...";
    batteryBar.style.width = "0%";
    batteryContainer.setAttribute("aria-valuenow", "0");
    if (Date.now() >= nextScheduleAttempt) {
      nextScheduleAttempt = Date.now() + 60000;
      loadSchedule(false);
    }
    return;
  }

  const yesterday = PrayerUtils.addDays(today, -1);
  const events = [];
  const previousIsha = PrayerUtils.toInstant(
    yesterday,
    (schedule.previousTimings || schedule.timings).Isha,
    schedule.timeZone
  );
  if (previousIsha) {
    events.push({ time: previousIsha, name: "Isya" });
  }
  for (const prayer of PrayerUtils.PRAYERS) {
    const time = PrayerUtils.toInstant(today, schedule.timings[prayer.key], schedule.timeZone);
    if (time) {
      events.push({ time, name: prayer.name });
    }
  }
  if (schedule.tomorrowTimings) {
    const time = PrayerUtils.toInstant(
      schedule.tomorrowDate,
      schedule.tomorrowTimings.Fajr,
      schedule.timeZone
    );
    if (time) {
      events.push({ time, name: "Subuh" });
    }
  }
  events.sort((left, right) => left.time - right.time);

  const nextIndex = events.findIndex(event => event.time > now);
  if (nextIndex < 0) {
    countdownElement.textContent = "--:--:--";
    nextPrayerElement.textContent = "Jadwal berikutnya belum tersedia";
    batteryBar.style.width = "0%";
    batteryContainer.setAttribute("aria-valuenow", "0");
    return;
  }

  const next = events[nextIndex];
  const previous = events[Math.max(0, nextIndex - 1)];
  const remaining = next.time - now;
  const totalInterval = next.time - previous.time;
  const elapsed = Math.max(0, totalInterval - remaining);
  const percentage = totalInterval > 0 ? Math.min(100, (elapsed / totalInterval) * 100) : 0;
  const seconds = Math.floor(remaining / 1000);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");

  countdownElement.textContent = `${hours}:${minutes}:${remainder}`;
  nextPrayerElement.textContent = `Menuju waktu sholat ${next.name}`;
  batteryBar.style.width = `${percentage}%`;
  batteryContainer.setAttribute("aria-valuenow", String(Math.round(percentage)));
}

function renderSchedule() {
  if (!schedule) {
    return;
  }
  renderPrayerTimes();
  timeZoneElement.textContent = `Zona waktu: ${schedule.timeZone} (${schedule.date})`;
  updateCountdown();
  if (schedule.stale) {
    statusElement.textContent = `Jadwal tersimpan ditampilkan; pembaruan gagal: ${schedule.error}`;
  } else {
    statusElement.textContent = "Jadwal berhasil diperbarui.";
  }
}

async function loadSchedule(force) {
  nextScheduleAttempt = Date.now() + 60000;
  statusElement.textContent = "Memuat jadwal...";
  try {
    const response = await sendMessage({ type: "getSchedule", force });
    schedule = response.schedule;
    applyPreferences(schedule.preferences);
    renderSchedule();
  } catch (error) {
    statusElement.textContent = `Gagal memuat jadwal: ${error.message}`;
    console.error("Gagal memuat jadwal sholat:", error);
    updateCountdown();
  }
}

function setBusy(isBusy) {
  saveButton.disabled = isBusy;
  refreshButton.disabled = isBusy;
}

saveButton.addEventListener("click", async () => {
  const preferences = getPreferencesFromForm();
  if (!preferences.address) {
    statusElement.textContent = "Masukkan lokasi terlebih dahulu.";
    addressInput.focus();
    return;
  }

  setBusy(true);
  statusElement.textContent = "Menyimpan pengaturan dan memperbarui jadwal...";
  try {
    const response = await sendMessage({ type: "savePreferences", preferences });
    applyPreferences(response.preferences);
    if (response.schedule) {
      schedule = response.schedule;
      renderSchedule();
    } else {
      schedule = null;
      renderPrayerTimes();
      timeZoneElement.textContent = "Zona waktu belum tersedia";
      updateCountdown();
      statusElement.textContent = `Pengaturan tersimpan, tetapi jadwal belum dapat diperbarui: ${response.warning}`;
    }
  } catch (error) {
    statusElement.textContent = `Gagal menyimpan pengaturan: ${error.message}`;
    console.error("Gagal menyimpan pengaturan:", error);
  } finally {
    setBusy(false);
  }
});

refreshButton.addEventListener("click", async () => {
  setBusy(true);
  await loadSchedule(true);
  setBusy(false);
});

notificationsInput.addEventListener("change", () => {
  reminderInput.disabled = !notificationsInput.checked;
});

applyPreferences(DEFAULT_PREFERENCES);
loadSchedule(false);
setInterval(updateCountdown, 1000);
