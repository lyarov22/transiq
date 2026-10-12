import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import type { KaeruCsvItem } from "kaeru/types";

const csvPath = join(".transiq", "kaeru.csv");

// Places for the stops the snapshot does not have, written by the deployment
// (punkto's `harvester/stop_places.py`) in the same format. Mostly stops the
// portal renamed since the snapshot was taken — `Štúrovo,,AS` for
// `Štúrovo,,aut.st.` — which would otherwise come out at -1,-1. A name the
// snapshot has is taken from the snapshot: this file only adds.
const extraPath = join(".transiq", "kaeru-extra.csv");

function readCsv(content: string): KaeruCsvItem[] {
  return parseCsv<KaeruCsvItem>(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    cast: true,
  });
}

const data = readCsv(await Bun.file(csvPath).text());
const extraFile = Bun.file(extraPath);
if (await extraFile.exists()) {
  const known = new Set(data.map((item) => item.cis_name));
  const extra = readCsv(await extraFile.text()).filter(
    (item) => !known.has(item.cis_name),
  );
  data.push(...extra);
  console.log(`Kaeru: ${extra.length} stops added from ${extraPath}`);
}

export function queryAllStopsByCisName(cisName: string): KaeruCsvItem[] {
  return data.filter((item) => item.cis_name === cisName);
}

export function findNearestDistricts(
  lat: number,
  lon: number,
  limit: number = 1,
): string[] {
  if (!lat || !lon || lat === -1 || lon === -1) return [];

  return data
    .filter((item) => item.district && item.lat !== -1 && item.lon !== -1)
    .sort((a, b) => {
      const distA = getDistance(lat, lon, a.lat, a.lon);
      const distB = getDistance(lat, lon, b.lat, b.lon);
      return distA - distB;
    })
    .slice(0, limit)
    .map((item) => item.district!)
    .filter((district, index, self) => self.indexOf(district) === index); // Remove duplicates
}

/** Kilometres between two points, straight line. */
export function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  return getDistance(lat1, lon1, lat2, lon2);
}

// Haversine formula
function getDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}
