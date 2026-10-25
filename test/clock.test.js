import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStoryClockValue, formatStoryClockValue, createInitialWorldDefaults, normalizeInitialWorldDefaults, applyInitialWorldDefaults, INITIAL_WEATHER_CHOICES } from "../src/clock.js";
import { expandTrackerRecord } from "../src/protocol.js";
import { fixtureState } from "./fixtures.js";

test("random starting values have valid fixed-range dates, local minutes and modest weather choices", () => {
  assert.deepEqual(createInitialWorldDefaults(() => 0), { date: "2020-01-01", time: "00:00", weather: "Clear skies" });
  assert.deepEqual(createInitialWorldDefaults(() => .999999), { date: "2039-12-31", time: "23:59", weather: INITIAL_WEATHER_CHOICES.at(-1) });
  const values = createInitialWorldDefaults(() => .42);
  assert.deepEqual(normalizeInitialWorldDefaults(values), values);
  assert.equal(normalizeInitialWorldDefaults({ ...values, date: "2031-02-29" }), null);
  assert.equal(normalizeInitialWorldDefaults({ ...values, time: "24:00" }), null);
  assert.equal(normalizeInitialWorldDefaults({ ...values, weather: "Unknown" }), null);
  const original = { action: "preserve", date: "Unknown", time: "After sunset", weather: "Unknown.", location: "Station" };
  assert.deepEqual(applyInitialWorldDefaults(original, values), { ...original, action: "update", date: values.date, weather: values.weather });
  assert.equal(original.date, "Unknown"); assert.equal(original.action, "preserve");
  assert.equal(applyInitialWorldDefaults({ ...original, action: "invalid" }, values).action, "invalid");
  assert.deepEqual(applyInitialWorldDefaults({ ...original, date: "Late autumn", weather: "No atmosphere" }, values), { ...original, date: "Late autumn", weather: "No atmosphere" });
});

test("exact fictional dates and local times normalize without using the host clock", () => {
  for (const [input, expected] of [["2031-6-2", "2031-06-02"], ["2000-2-29", "2000-02-29"]]) assert.equal(normalizeStoryClockValue("date", input), expected);
  for (const [input, expected] of [["9:05 pm", "21:05"], ["12:00 a.m.", "00:00"], ["12:00 PM", "12:00"], ["7:03", "07:03"], ["Midnight", "00:00"], ["Noon", "12:00"], ["9:05:03 PM", "21:05:03"]]) assert.equal(normalizeStoryClockValue("time", input), expected);
  for (const [field, values] of [["date", ["October 13", "Day 2, early spring", "Year 8 of the Reed calendar", "Unknown"]], ["time", ["Late afternoon", "Around 9:30 pm", "Unknown"]]]) {
    for (const value of values) assert.equal(normalizeStoryClockValue(field, value), value);
  }
});
test("invalid exact calendar and clock values reject with a field-specific repair path", () => {
  for (const [field, values] of [["date", ["2031-02-29", "1900-02-29", "2031-04-31", "2031-13-01", "2031-00-01", "2031-02-29 (Winter)"]], ["time", ["24:00", "12:60", "12:00:60", "0:30 AM", "13:00 PM", "25:15 (Night)"]]]) {
    for (const value of values) assert.throws(() => normalizeStoryClockValue(field, value), error => error.path === `world.${field}` && error.code === "invalid_clock");
  }
});

test("clock presentation omits Gregorian years, uses AM/PM and keeps narrative descriptions", () => {
  for (const [input, expected] of [
    ["2031-10-17 (Fall)", "October 17 (Fall)"], ["2031-6-2", "June 2"], ["2000-02-29", "February 29"],
    ["October 13, 2031 (Early fall)", "October 13 (Early fall)"], ["Fall", "Fall"], ["Day 2, early spring", "Day 2, early spring"],
    ["October 13", "October 13"], ["Unknown", "Unknown"],
  ]) assert.equal(formatStoryClockValue("date", input), expected);
  for (const [input, expected] of [
    ["00:00", "12:00 AM (Midnight)"], ["02:54", "02:54 AM (Late night)"], ["14:54", "02:54 PM (Afternoon)"],
    ["12:00", "12:00 PM (Noon)"], ["12:01", "12:01 PM (Afternoon)"], ["06:05", "06:05 AM (Early morning)"],
    ["08:30", "08:30 AM (Morning)"], ["18:30", "06:30 PM (Evening)"], ["23:59:30", "11:59:30 PM (Night)"],
    ["2:54 pm (After lunch)", "02:54 PM (After lunch)"], ["Midnight", "12:00 AM (Midnight)"],
    ["Late afternoon", "Late afternoon"], ["Unknown", "Unknown"],
  ]) assert.equal(formatStoryClockValue("time", input), expected);
  assert.equal(normalizeStoryClockValue("date", "2031-6-2 (Summer)"), "2031-06-02 (Summer)");
  assert.equal(normalizeStoryClockValue("time", "2:54 pm (After lunch)"), "14:54 (After lunch)");
});
test("compact and legacy tracker clock proposals normalize while preserve and omitted fields retain saved facts", () => {
  const { sourceMessageId, ...world } = fixtureState().world;
  const patch = { action: "update", changes: [{ field: "date", value: "2032-1-1" }, { field: "time", value: "12:10 am" }] };
  const compact = expandTrackerRecord(patch, "world", world), legacy = expandTrackerRecord({ ...world, date: "2032-1-1", time: "12:10 am", action: "update" }, "world", world);
  assert.equal(compact.date, "2032-01-01"); assert.equal(compact.time, "00:10"); assert.deepEqual(compact, legacy);
  assert.equal(expandTrackerRecord({ action: "preserve", changes: [] }, "world", world).time, "Midnight");
  assert.equal(expandTrackerRecord({ action: "update", changes: [{ field: "weather", value: "Clear" }] }, "world", world).time, "Midnight");
  assert.equal(expandTrackerRecord({ action: "update", changes: [{ field: "time", value: "00:00" }] }, "world", world).time, "Midnight");
});
