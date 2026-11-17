const DEFAULT_ADDRESS = "Bekasi, Indonesia";
const PRAYERS = [
  { key: "Fajr", name: "Subuh" },
  { key: "Dhuhr", name: "Zuhur" },
  { key: "Asr", name: "Asar" },
  { key: "Maghrib", name: "Magrib" },
  { key: "Isha", name: "Isya" }
];

const countdownElement = document.getElementById("countdown");
const nextPrayerElement = document.getElementById("nextPrayer");
const batteryBar = document.getElementById("batteryBar");
const addressInput = document.getElementById("addressInput");
const saveButton = document.getElementById("saveBtn");
const statusElement = document.getElementById("status");
let schedule = null;
let nextScheduleAttempt = 0;

addressInput.value = DEFAULT_ADDRESS;

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeOnDate(date, value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const result = new Date(date);
  result.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return result;
}

function updateCountdown() {
  const now = new Date();
  if (!schedule || schedule.scheduleDate !== dateKey(now)) {
    countdownElement.textContent = "--:--:--";
    nextPrayerElement.textContent = "Memuat jadwal...";
    batteryBar.style.width = "0%";
    if (Date.now() >= nextScheduleAttempt) {
      nextScheduleAttempt = Date.now() + 60000;
      loadSchedule(false);
    }
    return;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const events = [];
  const previousIsha = timeOnDate(yesterday, schedule.timings.Isha);
  if (previousIsha) {
    events.push({ time: previousIsha, name: "Isya" });
  }

  PRAYERS.forEach(prayer => {
    const time = timeOnDate(now, schedule.timings[prayer.key]);
    if (time) {
      events.push({ time, name: prayer.name });
    }
  });
  const fajrTomorrow = timeOnDate(tomorrow, schedule.tomorrowTimings && schedule.tomorrowTimings.Fajr);
  if (fajrTomorrow) {
    events.push({ time: fajrTomorrow, name: "Subuh" });
  }
  events.sort((left, right) => left.time - right.time);

  const nextIndex = events.findIndex(event => event.time > now);
  if (nextIndex < 0) {
    countdownElement.textContent = "--:--:--";
    nextPrayerElement.textContent = "Jadwal berikutnya belum tersedia";
    batteryBar.style.width = "0%";
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
}

function requestSchedule(force) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "getSchedule", force }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response || !response.ok) {
        reject(new Error(response && response.error ? response.error : "Jadwal tidak dapat dimuat"));
      } else {
        resolve(response.schedule);
      }
    });
  });
}

async function loadSchedule(force) {
  nextScheduleAttempt = Date.now() + 60000;
  statusElement.textContent = "Memuat jadwal...";
  try {
    schedule = await requestSchedule(force);
    addressInput.value = schedule.address || DEFAULT_ADDRESS;
    statusElement.textContent = "Jadwal berhasil diperbarui.";
    updateCountdown();
  } catch (error) {
    statusElement.textContent = `Gagal memuat jadwal: ${error.message}`;
    console.error("Gagal memuat jadwal sholat:", error);
    updateCountdown();
  }
}

saveButton.addEventListener("click", async () => {
  const address = addressInput.value.trim();
  if (!address) {
    statusElement.textContent = "Masukkan lokasi terlebih dahulu.";
    addressInput.focus();
    return;
  }

  saveButton.disabled = true;
  statusElement.textContent = "Menyimpan lokasi dan memperbarui jadwal...";
  try {
    await chrome.storage.local.set({ address });
    await loadSchedule(true);
  } catch (error) {
    statusElement.textContent = `Gagal menyimpan lokasi: ${error.message}`;
    console.error("Gagal menyimpan lokasi:", error);
  } finally {
    saveButton.disabled = false;
  }
});

loadSchedule(false);
setInterval(updateCountdown, 1000);
