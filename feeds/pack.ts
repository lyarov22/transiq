import { getGftsZip } from "cis/client";
import { createHash } from "node:crypto";
import { exists, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import type { Feed } from "./types";
import { applyFixesToZip, parseGtfsCsv } from "./utils";

/**
 * Turns what `cis:xlsx2gtfs` left in `.tmp/cp-sk/<id>/gtfs/` into the feeds we serve:
 * `dist/sk/<id>.zip`, a `.LICENSE` beside each, and `dist/manifest.json`.
 *
 * Only the `cis` feeds are packed — the others in `feeds/sk/` are somebody else's
 * published GTFS, which we take from their publisher, not through here.
 *
 * Before a zip replaces the one already in `dist/` it is looked at, because a
 * converter that goes wrong goes wrong quietly (the bug this fork was made for: a
 * feed with two-fifths of its trips written out without a single stop time, and
 * nothing to say so). A feed that fails is not published and the previous file
 * stays; the exit code says so.
 *
 *   bun feeds/pack.ts
 *
 * Environment:
 *   PACK_ONLY            comma-separated feed ids, for development
 *   PACK_OUT             output directory (default `dist`)
 *   PACK_MAX_BARE_SHARE  largest share of trips without stop_times (default 0.01)
 */

const outDir = process.env.PACK_OUT ?? "dist";
const maxBareShare = Number(process.env.PACK_MAX_BARE_SHARE ?? 0.01);
const only = process.env.PACK_ONLY?.split(",").map((id) => id.trim());

const feeds = (await loadCisFeeds()).filter(
  ({ feed }) => !only || only.includes(feed.id),
);

await mkdir(join(outDir, "sk"), { recursive: true });
const manifestPath = join(outDir, "manifest.json");
const manifest: { generated: string; feeds: Record<string, FeedEntry> } =
  (await exists(manifestPath))
    ? JSON.parse(await readFile(manifestPath, "utf-8"))
    : { generated: "", feeds: {} };

const failures: string[] = [];
let built = 0;

for (const { feed, folder } of feeds) {
  try {
    let buffer: ArrayBuffer;
    try {
      buffer = await getGftsZip(folder);
    } catch {
      console.warn(`${feed.id}: nothing converted for it, skipped`);
      continue;
    }
    if (feed.fixes) buffer = await applyFixesToZip(buffer, feed.fixes);

    const report = await audit(buffer);
    const problem = judge(report);
    if (problem) {
      failures.push(`${feed.id}: ${problem}`);
      console.error(`${feed.id}: NOT published — ${problem}`);
      continue;
    }

    const file = join(outDir, "sk", `${feed.id}.zip`);
    await Bun.write(`${file}.part`, buffer);
    await rename(`${file}.part`, file);
    await writeFile(`${file}.LICENSE`, licenseText(feed));

    manifest.feeds[feed.id] = {
      name: feed.name,
      bytes: buffer.byteLength,
      sha256: createHash("sha256").update(new Uint8Array(buffer)).digest("hex"),
      ...report,
    };
    built++;
    console.log(
      `${feed.id}: ${report.trips} trips, ${report.stopTimes} stop_times, ` +
        `${report.tripsWithoutTimes} without times, service ${report.firstDay}..${report.lastDay}`,
    );
  } catch (error) {
    failures.push(`${feed.id}: ${error}`);
    console.error(`${feed.id}: failed — ${error}`);
  }
}

manifest.generated = new Date().toISOString();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Packed ${built} of ${feeds.length} feeds into ${outDir}/sk`);
if (failures.length > 0) {
  console.error(`\n${failures.length} not published:\n  ${failures.join("\n  ")}`);
}
if (failures.length > 0 || built === 0) process.exit(1);

interface FeedEntry {
  name: string;
  bytes: number;
  sha256: string;
  trips: number;
  stopTimes: number;
  tripsWithoutTimes: number;
  firstDay: string;
  lastDay: string;
}

type Report = Omit<FeedEntry, "name" | "bytes" | "sha256">;

/**
 * The `cis` feeds of `feeds/sk/`, each with the folder its XLSX files were
 * converted in (usually its own id; RegioJet's is `student-agency-ks`).
 */
async function loadCisFeeds(): Promise<{ feed: Feed; folder: string }[]> {
  const dir = join(import.meta.dir, "sk");
  const found: { feed: Feed; folder: string }[] = [];
  for (const file of (await readdir(dir)).sort()) {
    if (!file.endsWith(".ts")) continue;
    // Read, not run: `getLatestSource` of the other feeds asks Google Drive.
    if (!/type:\s*"cis"/.test(await readFile(join(dir, file), "utf-8"))) continue;
    const feed = (await import(`./sk/${file}`)).default as Feed;
    const source = await feed.getLatestSource();
    if (source.type === "cis") found.push({ feed, folder: source.id });
  }
  return found;
}

async function audit(buffer: ArrayBuffer): Promise<Report> {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name: string) =>
    (await zip.file(name)?.async("string")) ?? "";

  const trips = parseGtfsCsv(await read("trips.txt"));
  const stopTimes = parseGtfsCsv(await read("stop_times.txt"));
  const timed = new Set(stopTimes.map((row) => row.trip_id));
  const calendar = parseGtfsCsv(await read("calendar.txt"));
  const days = calendar.flatMap((row) => [row.start_date, row.end_date]).filter(Boolean).sort();

  return {
    trips: trips.length,
    stopTimes: stopTimes.length,
    tripsWithoutTimes: trips.filter((trip) => !timed.has(trip.trip_id!)).length,
    firstDay: days[0] ?? "",
    lastDay: days[days.length - 1] ?? "",
  };
}

/** A reason not to publish, or null. */
function judge(report: Report): string | null {
  if (report.trips === 0) return "no trips";
  if (report.stopTimes === 0) return "no stop_times";
  const share = report.tripsWithoutTimes / report.trips;
  if (share > maxBareShare) {
    return `${report.tripsWithoutTimes} of ${report.trips} trips (${(share * 100).toFixed(1)}%) have no stop_times`;
  }
  return null;
}

function licenseText(feed: Feed): string {
  const lines = [`Data source: ${feed.name}`];
  if (feed.license?.type) lines.push(`License: ${feed.license.type}`);
  if (feed.license?.url) lines.push(`License URL: ${feed.license.url}`);
  if (feed.license?.attribution) lines.push(`Attribution: ${feed.license.attribution}`);
  if (feed.license?.notes) lines.push(`Notes: ${feed.license.notes}`);
  lines.push("Retrieved from: http://portal.cp.sk/");
  lines.push(`Retrieved: ${new Date().toISOString().split("T")[0]}`);
  return lines.join("\n") + "\n";
}
