var PrayerUtils = (() => {
  const PRAYERS = [
    { key: "Fajr", name: "Subuh" },
    { key: "Dhuhr", name: "Zuhur" },
    { key: "Asr", name: "Asar" },
    { key: "Maghrib", name: "Magrib" },
    { key: "Isha", name: "Isya" }
  ];
  const SCHEDULE_TIMES = [
    { key: "Imsak", name: "Imsak" },
    PRAYERS[0],
    { key: "Sunrise", name: "Terbit" },
    ...PRAYERS.slice(1),
    { key: "Midnight", name: "Tengah malam" },
    { key: "Lastthird", name: "Sepertiga malam terakhir" }
  ];

  function dateKey(date, timeZone) {
    if (!timeZone) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function addDays(key, amount) {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + amount));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function apiDate(key) {
    const [year, month, day] = key.split("-");
    return `${day}-${month}-${year}`;
  }

  function parseTime(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
    if (!match) {
      return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours < 24 && minutes < 60 ? { hours, minutes } : null;
  }

  function toInstant(key, value, timeZone) {
    const parsed = parseTime(value);
    if (!parsed) {
      return null;
    }

    const [year, month, day] = key.split("-").map(Number);
    const target = Date.UTC(year, month - 1, day, parsed.hours, parsed.minutes);
    let instant = target;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
      const represented = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute)
      );
      const difference = target - represented;
      instant += difference;
      if (difference === 0) {
        break;
      }
    }

    return new Date(instant);
  }

  function getPrayerProgress(schedule, now) {
    const today = dateKey(now, schedule.timeZone);
    if (schedule.date !== today) {
      return null;
    }

    const yesterday = addDays(today, -1);
    const events = [];
    const previousTimings = schedule.previousTimings || schedule.timings;
    const previousIsha = toInstant(yesterday, previousTimings.Isha, schedule.timeZone);
    if (previousIsha) {
      events.push({ time: previousIsha, date: yesterday, key: "Isha", name: "Isya" });
    }

    for (const prayer of PRAYERS) {
      const time = toInstant(today, schedule.timings[prayer.key], schedule.timeZone);
      if (time) {
        events.push({ time, date: today, key: prayer.key, name: prayer.name });
      }
    }
    if (schedule.tomorrowTimings) {
      for (const prayer of PRAYERS) {
        const time = toInstant(schedule.tomorrowDate, schedule.tomorrowTimings[prayer.key], schedule.timeZone);
        if (time) {
          events.push({ time, date: schedule.tomorrowDate, key: prayer.key, name: prayer.name });
        }
      }
    }
    events.sort((left, right) => left.time - right.time);

    const nextIndex = events.findIndex(event => event.time > now);
    if (nextIndex < 1) {
      return null;
    }
    const next = events[nextIndex];
    const previous = events[nextIndex - 1];
    const remainingMs = next.time - now;
    const intervalMs = next.time - previous.time;
    const elapsedMs = Math.max(0, intervalMs - remainingMs);
    return {
      next,
      remainingMs,
      percentage: intervalMs > 0 ? Math.min(100, (elapsedMs / intervalMs) * 100) : 0
    };
  }

  return { PRAYERS, SCHEDULE_TIMES, addDays, apiDate, dateKey, getPrayerProgress, parseTime, toInstant };
})();
