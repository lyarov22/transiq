/**
 * A run that does not call at every stop keeps the times it has.
 *
 * In a CIS timetable a run is a column and the stops are the rows, from row 5 down.
 * A run need not call at every stop: a short working that begins at an intermediate
 * stop has blank cells above its first time, and one that ends early has them below
 * its last. The loop over a column used to stop at the first blank cell, so a run that
 * did not begin on the first row got no stop_times at all — and was still written out
 * as a trip, without stops and without a shape. On the published SAD Žilina feed that
 * was 1,494 of 4,536 trips (line 050112 towards Čadca: 26 of 31); across the regional
 * bus feeds it was close to half.
 *
 * This builds a small workbook with the shapes that matter and runs the real parser
 * over it:
 *
 *   * a run on every row                       — the case that always worked;
 *   * a run beginning on the second row        — the bug: it lost every time;
 *   * a run beginning on the third row         — the same, lower down;
 *   * a run with a blank in the middle         — it used to end at the gap;
 *   * a run with a single time                 — not a trip a router can board, so
 *                                                it is not written out at all.
 *
 * The footnote under the stop list (column A only, as in the real files) must not be
 * read as a stop or as a time.
 *
 *   bun cis/xlsx2gtfs/__tests__/blank-cells.mjs
 *
 * Exits non-zero on a disagreement, like `lone-match.mjs` next to it. It imports the
 * parser itself rather than a copy, so it needs bun, as the rest of the pipeline does.
 */
import * as XLSX from "xlsx";
import { parseRouteTripsCalendarsAndStopTimes } from "../parser/index.ts";
import { resetIds } from "../utils/id.ts";

const STOPS = ["Stop A", "Stop B", "Stop C", "Stop D"];

// Rows 5..8 are the four stops; each column is one run. `null` is a blank cell.
const RUNS = {
  "Spoj 1": ["5:00", "5:10", "5:20", "5:30"],
  "Spoj 2": [null, "6:10", "6:20", "6:30"],
  "Spoj 3": [null, null, "7:20", "7:30"],
  "Spoj 4": ["8:00", "8:10", null, "8:30"],
  "Spoj 5": [null, null, null, "9:30"],
};
// What each run should come out as: the stops it calls at, in order.
const WANT = {
  "Spoj 1": ["Stop A", "Stop B", "Stop C", "Stop D"],
  "Spoj 2": ["Stop B", "Stop C", "Stop D"],
  "Spoj 3": ["Stop C", "Stop D"],
  "Spoj 4": ["Stop A", "Stop B", "Stop D"],
  // "Spoj 5" has one time: no trip.
};

function workbook() {
  const names = Object.keys(RUNS);
  const run = XLSX.utils.aoa_to_sheet([
    ["Linka číslo 050113", null, "Žilina - Kysucké Nové Mesto "],
    ["Platí od 01.09.2026 do 12.12.2026"],
    ["Tč", null, null, ...names],
    [null, null, null, ...names.map(() => "X")],
    ...STOPS.map((stop, row) => [
      String(row + 1),
      stop,
      row === 0 ? "odjazd" : null,
      ...names.map((name) => RUNS[name][row]),
    ]),
    [],
    ["Prepravu zabezpečuje: Test a.s., Testovacia 1, 010 01 Žilina"],
  ]);
  const signs = XLSX.utils.aoa_to_sheet([
    [null, null, "Žilina - Kysucké Nové Mesto "],
    [],
    ["Značka", "Vysvetlenie"],
    ["X", "premáva v pracovných dňoch"],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, run, "Smer tam");
  XLSX.utils.book_append_sheet(book, signs, "Vysvetlenie značiek");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

const agency = {
  agency_id: "test",
  agency_name: "Test a.s.",
  agency_timezone: "Europe/Bratislava",
  agency_lang: "sk",
};
const stops = Object.fromEntries(
  STOPS.map((name, index) => [
    `s${index}`,
    {
      stop_id: `s${index}`,
      stop_name: name,
      stop_lat: 49 + index / 100,
      stop_lon: 18,
      location_type: 0,
      metadata: { cis_name: name },
    },
  ]),
);

resetIds();
const { trips, stopTimes } = parseRouteTripsCalendarsAndStopTimes(
  agency,
  "L050113_260901_115605.xlsx",
  stops,
  workbook(),
);

let problems = 0;
const fail = (message) => {
  console.error(message);
  problems += 1;
};

const nameOf = (stopId) => stops[stopId].stop_name;
const calls = (tripId) =>
  stopTimes
    .filter((time) => time.trip_id === tripId)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);

// Every trip written out must have stop_times — a trip without them is invalid GTFS.
for (const trip of trips) {
  if (calls(trip.trip_id).length < 2) {
    fail(`trip ${trip.trip_id} was written out with ${calls(trip.trip_id).length} stop_times`);
  }
}

// Runs come out in column order, so the nth trip is the nth run that survived.
const wanted = Object.entries(WANT);
if (trips.length !== wanted.length) {
  fail(`expected ${wanted.length} trips (the run with one time is dropped), got ${trips.length}`);
}
wanted.forEach(([run, want], index) => {
  const trip = trips[index];
  if (!trip) return fail(`${run}: no trip`);
  const got = calls(trip.trip_id);
  const names = got.map((time) => nameOf(time.stop_id));
  if (JSON.stringify(names) !== JSON.stringify(want)) {
    fail(`${run}: stops ${JSON.stringify(names)}, expected ${JSON.stringify(want)}`);
  }
  // Numbered from 1 with no holes, whatever row the run began on.
  const sequence = got.map((time) => time.stop_sequence);
  if (JSON.stringify(sequence) !== JSON.stringify(want.map((_, i) => i + 1))) {
    fail(`${run}: stop_sequence ${JSON.stringify(sequence)}`);
  }
  // And the times are the cells' own, in order.
  const clock = got.map((time) => time.departure_time);
  if (clock.some((time, i) => i > 0 && time < clock[i - 1])) {
    fail(`${run}: departure times go backwards: ${JSON.stringify(clock)}`);
  }
});

// The footnote under the stop list is not a stop.
if (stopTimes.some((time) => !STOPS.includes(nameOf(time.stop_id)))) {
  fail("a stop_time points at something that is not on the stop list");
}

if (problems > 0) {
  console.error(`\n${problems} problem(s)`);
  process.exit(1);
}
console.log(`blank-cells: ${trips.length} trips, ${stopTimes.length} stop_times, 0 problems`);
