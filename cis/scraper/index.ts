import { pause, processNestedPages } from "./pager";
import { parseHTML } from "linkedom";
import {
  exists,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * Fetches the XLSX timetables from portal.cp.sk, for the operators in
 * `cis/agencies.txt`, into `.tmp/cp-sk/<operator>/`.
 *
 * The portal is somebody else's server, so this is a guest on it:
 *
 *   * one request at a time, with a pause between any two (`CIS_DELAY_MS`, 1000);
 *   * it says what it is (`CIS_USER_AGENT`, `bot/1.0`) and not what it is not;
 *   * it takes only the operators it needs — the others cost one page to recognise;
 *   * it keeps what it has: a timetable file is named after its route and the day it
 *     was issued, so a file that is already here is the same file and is not fetched
 *     again. A second run on the same day asks for the listing pages and downloads
 *     nothing.
 *
 * It works in two passes. The first reads the portal's listing to its end and notes,
 * for every route, the newest issue the portal offers (an operator may be listed
 * under several pages, and a route under several issues). The second downloads what
 * is not here yet, removes the issues those supersede, and removes the routes the
 * portal no longer lists — but only when the first pass saw everything.
 *
 * Environment:
 *   CIS_AGENCIES    comma-separated operators, or `all`; default: cis/agencies.txt
 *   CIS_OUTER_ONLY  comma-separated outer page numbers to visit (development)
 *   CIS_DELAY_MS    pause between requests, milliseconds (default 1000)
 *   CIS_USER_AGENT  the User-Agent header (default `bot/1.0`)
 */

/** What an XLSX (a zip) starts with; an error page does not. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const delayMs = Number(process.env.CIS_DELAY_MS ?? 1000);
const userAgent = process.env.CIS_USER_AGENT ?? "bot/1.0";
const fetchOptions = { headers: { "User-Agent": userAgent } };

await mkdir(".tmp", { recursive: true });

const dir = join(".tmp", "cp-sk");
await mkdir(dir, { recursive: true });

const wanted = await wantedAgencies();
const outerOnly = process.env.CIS_OUTER_ONLY
  ? process.env.CIS_OUTER_ONLY.split(",").map((n) => Number(n.trim()))
  : undefined;

console.log(
  wanted
    ? `Wanted operators (${wanted.size}): ${[...wanted].join(", ")}`
    : "Wanted operators: all",
);

/** What the run did, for the last line of the log. */
const totals = { pages: 0, downloaded: 0, kept: 0, removed: 0, failed: 0 };
const seenAgencies = new Set<string>();

interface AgencyContext {
  agency: string;
  folderName: string;
}

interface Offer {
  /** The file's name on the portal: `L<route>_<yymmdd>_<id>.xlsx`. */
  fileName: string;
  /** Its address relative to the portal. */
  href: string;
}

/**
 * What the portal offers, by folder. An operator can appear under several outer
 * pages (SAD Žilina is `io=76` and `io=77`, each listing different routes), so what
 * is offered, and what is no longer, can only be said once the walk is done.
 */
const offered = new Map<
  string,
  { names: Set<string>; newest: Map<string, Offer> }
>();

await processNestedPages<AgencyContext>({
  baseUrl: "http://portal.cp.sk/Search.aspx?c=7&mi=7&sv=",
  outerParam: "io",
  outerStartPage: 0,
  outerPages: outerOnly,
  delayMs,
  innerParam: "p",
  innerStartPage: 0,
  fetchOptions,
  shouldStopInner: (_, body) =>
    body.includes(
      "Žiadny záznam nevyhovuje aktuálne nastavenej kombinácii typov liniek.",
    ),
  shouldStopOuter: (_, body) => body.includes("Chyba spracovania dotazu"),
  encodings: ["windows-1250"],

  // The first inner page names the operator.
  processOuterPage: async (page) => {
    const { document } = parseHTML(page.body);

    const agencyFull = document
      .querySelector("td.SectionTitle b")
      ?.textContent.trim()!;
    let agency = agencyFull;
    if (agency?.includes(", a.s.,") || agency?.includes(", spol. s r.o.,"))
      agency = agency.split(",").slice(0, 2).join(",");
    else agency = agency?.split(",")[0]!;

    const folderName = sanitizeFolderName(agency);
    seenAgencies.add(folderName);
    if (wanted && !wanted.has(folderName)) {
      console.log(`Skipping agency: ${agency} (${folderName})`);
      return null;
    }
    console.log(`Processing agency: ${agency} (folder: ${folderName})`);

    await mkdir(join(dir, folderName), { recursive: true });

    // The names this operator has gone by, each once.
    const names = new Set([agencyFull]);
    const infoPath = join(dir, folderName, "info.json");
    if (await exists(infoPath)) {
      for (const name of JSON.parse(await readFile(infoPath, "utf-8"))
        .agency_full ?? [])
        names.add(name);
    }
    await writeFile(
      infoPath,
      JSON.stringify(
        {
          agency_short: agency,
          agency_full: [...names],
          folder_name: folderName,
        },
        null,
        2,
      ),
    );
    totals.pages++;
    if (!offered.has(folderName)) {
      offered.set(folderName, { names: new Set(), newest: new Map() });
    }

    return { agency, folderName };
  },

  // Each page lists timetable files, usually several issues of one route.
  processInnerPage: async (page, { agency, folderName }) => {
    console.log(`Processing inner page ${page.innerPage} for agency ${agency}`);
    const { document } = parseHTML(page.body);
    const { names, newest } = offered.get(folderName)!;

    const links = document.querySelectorAll('a[href^="Down.aspx?f=xls/"]');

    // @ts-expect-error it's possible to iterate over NodeList
    for (const link of links) {
      const href = link.getAttribute("href")!;
      const fileName = href.slice(16);
      names.add(fileName);

      // Issues of one route sort by name: the route, then the day, then an id.
      const route = routeOf(fileName) ?? fileName;
      const best = newest.get(route);
      if (!best || fileName > best.fileName)
        newest.set(route, { fileName, href });
    }
  },
});

// Second pass: only now is it known what is the newest issue of each route.
for (const [folderName, { names, newest }] of offered) {
  const folder = join(dir, folderName);
  let failed = 0;

  for (const [route, { fileName, href }] of newest) {
    const target = join(folder, fileName);
    if (await exists(target)) {
      totals.kept++;
    } else {
      try {
        await downloadFile(`http://portal.cp.sk/${href}`, target);
        totals.downloaded++;
        console.log(
          `Successfully downloaded ${fileName} (newest version for route ${route})`,
        );
      } catch (error) {
        failed++;
        totals.failed++;
        console.error(`Failed to download ${fileName}: ${error}`);
        continue;
      }
    }

    // The route's earlier issues are superseded by this one.
    totals.removed += await removeOthers(
      folder,
      (file) => routeOf(file) === route && file !== fileName,
    );
  }

  // A file the portal no longer lists is a route that has been withdrawn. But a
  // listing that was cut short looks the same, so nothing is removed unless the
  // walk visited every operator page (not `CIS_OUTER_ONLY`) and none of this
  // operator's downloads failed.
  if (!outerOnly && failed === 0 && names.size > 0) {
    totals.removed += await removeOthers(folder, (file) => !names.has(file));
  }
}

const missing = [...(wanted ?? [])].filter((id) => !seenAgencies.has(id));
if (!outerOnly && missing.length > 0) {
  console.warn(
    `Not found on the portal (renamed, or no longer published?): ${missing.join(", ")}`,
  );
}

console.log(
  `Done: ${totals.pages} operator pages, ${totals.downloaded} downloaded, ` +
    `${totals.kept} already here, ${totals.removed} removed, ${totals.failed} failed`,
);
if (totals.failed > 0 || (!outerOnly && missing.length > 0)) process.exit(1);

async function wantedAgencies(): Promise<Set<string> | null> {
  const fromEnv = process.env.CIS_AGENCIES?.trim();
  if (fromEnv === "all") return null;

  const text = fromEnv
    ? fromEnv.split(",").join("\n")
    : await readFile(join(import.meta.dir, "..", "agencies.txt"), "utf-8");
  const ids = text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
  return new Set(ids);
}

/** `050111` for `L050111_260901_115603.xlsx`; null for a name of another shape. */
function routeOf(fileName: string): string | null {
  return fileName.match(/^L(\d+)_\d{6}_/)?.[1] ?? null;
}

/** Deletes the folder's `.xlsx` files that `unwanted` picks out; returns how many. */
async function removeOthers(
  folder: string,
  unwanted: (file: string) => boolean,
): Promise<number> {
  let removed = 0;
  for (const file of await readdir(folder)) {
    if (!file.endsWith(".xlsx") || !unwanted(file)) continue;
    await rm(join(folder, file));
    removed++;
    console.log(`Removed ${file}`);
  }
  return removed;
}

async function downloadFile(url: string, fileName: string): Promise<void> {
  await pause(delayMs);
  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  // The portal answers a missing or withdrawn file with an HTML page and status 200.
  const body = new Uint8Array(await response.arrayBuffer());
  if (!ZIP_MAGIC.every((byte, i) => body[i] === byte)) {
    throw new Error(
      `not an XLSX (${response.headers.get("content-type") ?? "no content-type"}, ${body.length} bytes)`,
    );
  }

  // Written under another name first: a file that is here is a whole file.
  const partial = `${fileName}.part`;
  await Bun.write(partial, body);
  await rename(partial, fileName);
}

function sanitizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\.,:;'"!?()[\]{}\/\\+*=&%$#@^|<>]/g, "")
    .replace(/\s+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
