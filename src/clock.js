export const INITIAL_WEATHER_CHOICES = Object.freeze(["Clear skies", "Partly cloudy", "Overcast", "Light rain", "Light breeze and dry skies"]);

// Fictional choices from a fixed range, independent of the machine's current
// date/time. The backend saves one set per native setup/source fingerprint.
export function createInitialWorldDefaults(random = Math.random) {
  const start = Date.UTC(2020, 0, 1), days = (Date.UTC(2040, 0, 1) - start) / 86400000;
  const date = new Date(start + Math.floor(random() * days) * 86400000).toISOString().slice(0, 10);
  const minute = Math.floor(random() * 1440);
  return { date, time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
    weather: INITIAL_WEATHER_CHOICES[Math.floor(random() * INITIAL_WEATHER_CHOICES.length)] };
}

export function normalizeInitialWorldDefaults(value) {
  if (!value || Object.keys(value).sort().join(",") !== "date,time,weather"
    || typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
    || typeof value.time !== "string" || !/^\d{2}:\d{2}$/.test(value.time) || !INITIAL_WEATHER_CHOICES.includes(value.weather)) return null;
  try { return { date: normalizeStoryClockValue("date", value.date), time: normalizeStoryClockValue("time", value.time), weather: value.weather }; }
  catch { return null; }
}

export function applyInitialWorldDefaults(world, defaults) {
  const filled = { ...world };
  for (const field of ["date", "time", "weather"]) if (typeof filled[field] === "string" && /^unknown\.?$/i.test(filled[field].trim())) {
    filled[field] = defaults[field];
    if (filled.action === "preserve") filled.action = "update";
  }
  return filled;
}

const CLOCK_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function clockParts(value) {
  const text = value.trim(), match = text.match(/^(.*?)\s+\(([^()\r\n]+)\)$/);
  return match ? { value: match[1], description: match[2].trim() } : { value: text, description: "" };
}
const withClockDescription = (value, description) => description ? `${value} (${description})` : value;
function clockPeriod(hour, minute, second) {
  if (!minute && !second && hour === 0) return "Midnight";
  if (!minute && !second && hour === 12) return "Noon";
  return hour < 5 ? "Late night" : hour < 8 ? "Early morning" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : hour < 21 ? "Evening" : "Night";
}

// Readable story presentation; canonical values retain their calendar precision.
// Seasons are retained from story facts, never inferred from a Gregorian month.
export function formatStoryClockValue(field, value) {
  if (typeof value !== "string") return value;
  let normalized;
  try { normalized = normalizeStoryClockValue(field, value); } catch { return value; }
  const parts = clockParts(normalized);
  if (field === "date") {
    const exact = parts.value.match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (exact) return withClockDescription(`${CLOCK_MONTHS[Number(exact[1]) - 1]} ${Number(exact[2])}`, parts.description);
    const monthNames = CLOCK_MONTHS.join("|");
    const written = parts.value.match(new RegExp(`^(${monthNames}) (\\d{1,2})(?:st|nd|rd|th)?,? \\d{4}$`, "i"));
    if (written) return withClockDescription(`${written[1]} ${Number(written[2])}`, parts.description);
  }
  if (field === "time") {
    const exact = parts.value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (exact) {
      const hour = Number(exact[1]), minute = Number(exact[2]), second = Number(exact[3] ?? 0);
      const display = `${String(hour % 12 || 12).padStart(2, "0")}:${exact[2]}${exact[3] === undefined ? "" : `:${exact[3]}`} ${hour < 12 ? "AM" : "PM"}`;
      return withClockDescription(display, parts.description || clockPeriod(hour, minute, second));
    }
  }
  return value;
}

// Normalize only unambiguous exact values proposed by the tracker. Partial dates,
// fictional calendars, approximate times and existing saved facts remain usable.
export function normalizeStoryClockValue(field, value) {
  if (typeof value !== "string") return value;
  const { value: text, description } = clockParts(value);
  const invalid = () => { throw Object.assign(new Error(`world.${field} has an invalid exact ${field}; use a valid fictional calendar date or local clock time`), { path: `world.${field}`, code: "invalid_clock" }); };
  if (field === "date") {
    const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return value;
    const [, yearText, monthText, dayText] = match, year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid();
    return withClockDescription(`${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`, description);
  }
  if (field === "time") {
    if (/^midnight$/i.test(text)) return withClockDescription("00:00", description);
    if (/^noon$/i.test(text)) return withClockDescription("12:00", description);
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
    if (!match) return value;
    let hour = Number(match[1]);
    const minute = Number(match[2]), second = match[3] === undefined ? null : Number(match[3]);
    const meridiem = match[4]?.replace(/\./g, "").toLowerCase();
    if (minute > 59 || second !== null && second > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) invalid();
    if (meridiem) hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
    return withClockDescription(`${String(hour).padStart(2, "0")}:${match[2]}${second === null ? "" : `:${match[3]}`}`, description);
  }
  return value;
}
