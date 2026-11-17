const DEFAULT_PREFERENCES = {
  address: "Bekasi, Indonesia",
  method: 20,
  shafaq: "general",
  midnightMode: 0,
  school: 0,
  notificationsEnabled: true,
  reminderMinutes: 0
};

const countdownElement = document.getElementById("countdown");
const nextPrayerElement = document.getElementById("nextPrayer");
const progressBar = document.getElementById("progressBar");
const progressTrack = document.querySelector(".progress-track");
const addressInput = document.getElementById("addressInput");
const methodInput = document.getElementById("methodInput");
const shafaqSetting = document.getElementById("shafaqSetting");
const shafaqInput = document.getElementById("shafaqInput");
const midnightModeInput = document.getElementById("midnightModeInput");
const schoolInput = document.getElementById("schoolInput");
const notificationsInput = document.getElementById("notificationsInput");
const reminderInput = document.getElementById("reminderInput");
const saveButton = document.getElementById("saveBtn");
const refreshButton = document.getElementById("refreshBtn");
const statusElement = document.getElementById("status");
const timeZoneElement = document.getElementById("timeZone");
const prayerTimesElement = document.getElementById("prayerTimes");
const locationDisplay = document.getElementById("locationDisplay");
const dateDisplay = document.getElementById("dateDisplay");
let schedule = null;
let nextScheduleAttempt = 0;

function getPreferencesFromForm() {
  return {
    address: addressInput.value.trim(),
    method: Number(methodInput.value),
    shafaq: shafaqInput.value,
    midnightMode: Number(midnightModeInput.value),
    school: Number(schoolInput.value),
    notificationsEnabled: notificationsInput.checked,
    reminderMinutes: Number(reminderInput.value)
  };
}

function applyPreferences(preferences) {
  addressInput.value = preferences.address || DEFAULT_PREFERENCES.address;
  methodInput.value = String(preferences.method);
  shafaqInput.value = preferences.shafaq || DEFAULT_PREFERENCES.shafaq;
  shafaqSetting.hidden = preferences.method !== 15;
  midnightModeInput.value = String(
    preferences.midnightMode === undefined ? DEFAULT_PREFERENCES.midnightMode : preferences.midnightMode
  );
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

function renderPrayerTimes(nextPrayerKey) {
  prayerTimesElement.replaceChildren();
  if (!schedule) {
    return;
  }
  for (const prayer of PrayerUtils.SCHEDULE_TIMES) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const time = document.createElement("time");
    const classes = [];
    if (prayer.key === nextPrayerKey) {
      classes.push("is-next");
    }
    if (prayer.key === "Sunrise") {
      classes.push("sunrise");
    } else if (["Imsak", "Midnight", "Lastthird"].includes(prayer.key)) {
      classes.push("night-time");
    }
    item.className = classes.join(" ");
    name.className = "time-name";
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
    progressBar.style.width = "0%";
    progressTrack.setAttribute("aria-valuenow", "0");
    if (Date.now() >= nextScheduleAttempt) {
      nextScheduleAttempt = Date.now() + 60000;
      loadSchedule(false);
    }
    return;
  }

  const progress = PrayerUtils.getPrayerProgress(schedule, now);
  if (!progress) {
    countdownElement.textContent = "--:--:--";
    nextPrayerElement.textContent = "Jadwal berikutnya belum tersedia";
    progressBar.style.width = "0%";
    progressTrack.setAttribute("aria-valuenow", "0");
    return;
  }

  const seconds = Math.floor(progress.remainingMs / 1000);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");

  countdownElement.textContent = `${hours}:${minutes}:${remainder}`;
  nextPrayerElement.textContent = `Menuju waktu sholat ${progress.next.name}`;
  progressBar.style.width = `${progress.percentage}%`;
  progressTrack.setAttribute("aria-valuenow", String(Math.round(progress.percentage)));
}

function renderSchedule() {
  if (!schedule) {
    return;
  }
  locationDisplay.textContent = schedule.address;
  dateDisplay.textContent = new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: schedule.timeZone
  }).format(new Date());
  const progress = PrayerUtils.getPrayerProgress(schedule, new Date());
  const nextPrayerKey = progress && progress.next.date === schedule.date ? progress.next.key : null;
  renderPrayerTimes(nextPrayerKey);
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
      locationDisplay.textContent = response.preferences.address;
      dateDisplay.textContent = "Jadwal belum tersedia";
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

methodInput.addEventListener("change", () => {
  shafaqSetting.hidden = Number(methodInput.value) !== 15;
});

applyPreferences(DEFAULT_PREFERENCES);
loadSchedule(false);
setInterval(updateCountdown, 1000);
