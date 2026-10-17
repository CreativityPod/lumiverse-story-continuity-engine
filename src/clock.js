// Normalize only unambiguous exact values proposed by the tracker. Partial dates,
// fictional calendars, approximate times and existing saved facts remain usable.
export function normalizeStoryClockValue(field, value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  const invalid = () => { throw Object.assign(new Error(`world.${field} has an invalid exact ${field}; use a valid fictional calendar date or local clock time`), { path: `world.${field}`, code: "invalid_clock" }); };
  if (field === "date") {
    const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return value;
    const [, yearText, monthText, dayText] = match, year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid();
    return `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`;
  }
  if (field === "time") {
    if (/^midnight$/i.test(text)) return "00:00";
    if (/^noon$/i.test(text)) return "12:00";
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
    if (!match) return value;
    let hour = Number(match[1]);
    const minute = Number(match[2]), second = match[3] === undefined ? null : Number(match[3]);
    const meridiem = match[4]?.replace(/\./g, "").toLowerCase();
    if (minute > 59 || second !== null && second > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) invalid();
    if (meridiem) hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
    return `${String(hour).padStart(2, "0")}:${match[2]}${second === null ? "" : `:${match[3]}`}`;
  }
  return value;
}
