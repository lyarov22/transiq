# This fork

A fork of [xhyrom/transiq](https://github.com/xhyrom/transiq) (Apache-2.0), run by
[punkto](https://punkto.sk) so that its Slovak regional bus timetables do not depend
on anybody else's server. What it is for is the same as upstream's: turn the XLSX
timetables of [portal.cp.sk](http://portal.cp.sk/) into GTFS. What differs:

| | upstream | this fork |
|---|---|---|
| `xlsx2gtfs` | a run that does not call at the first stop of the table gets no `stop_times` and is written out as a trip anyway (≈ half of the regional buses) | fixed, with a test: `bun run test` → `cis/xlsx2gtfs/__tests__/blank-cells.mjs` |
| scraper | every operator on the portal, a request as fast as the answer comes, a browser User-Agent, every file again on every run | only the operators our `cis` feeds read from; one request at a time, a pause of a second between any two; `bot/1.0`; a file that is already here is not fetched again |
| output | `gtfs/` branch, after shapes (`morph`) | `dist/sk/<id>.zip` + `dist/manifest.json`, after a check (`feeds/pack.ts`); a feed that fails it is not published and keeps its previous file |
| CI | daily, publishes to a branch | `workflow_dispatch` only; we run it on our own server (`deploy/build-timetables.sh` in punkto) |

Not changed on purpose: the parser, the stop database (`.transiq/kaeru.csv`), the feed
definitions — until there is a reason to. The idea is to stay close to upstream for
now and rewrite what we need rewritten later, with the numbers of a working pipeline
in hand.

## Run

```
bun install
bun cis:build          # = cis:scrape → cis:xlsx2gtfs → feeds:pack
bun run test           # the parser's cases
```

`CIS_AGENCIES=sad-zilina-as bun cis:scrape` takes one operator (it still has to read
the portal's list of operators to find it); `CIS_AGENCIES=all` takes every operator,
as upstream does. `PACK_ONLY=sad-zilina-as bun feeds:pack` packs one feed.

## Known limits

* **Stops.** Coordinates come from `.transiq/kaeru.csv`, a snapshot of ≈ 14 000 stop
  names, and from `.transiq/kaeru-extra.csv` when it exists: the same format, for
  names the snapshot does not have, written by the deployment (punkto's
  `harvester/stop_places.py`, from Ubian and from the snapshot's own renamed stops —
  the portal now says `Štúrovo,,AS` where the snapshot has `Štúrovo,,aut.st.`). A stop
  in neither, or ambiguous, gets `-1,-1` and stays in the feed (the consumer has to
  drop those; punkto's `harvester/sanitize_feed.py` does).
* **Shapes** (`morph`) are not built here; the routers snap to the road network.
* **robots.txt.** `portal.cp.sk/robots.txt` disallows `/Search.aspx` and `/Down.aspx`
  for every robot. Upstream does the same, daily, from GitHub Actions. This fork asks
  for much less (see above) and says who it is, but it does not make that go away.
* **A release that has not come into force yet replaces the one that has.** The portal
  names files by the day they take effect (`261012`), and the scraper — like upstream's —
  takes the newest release of a route. Today that is 5 routes of 1 210, all starting
  tomorrow. If the portal publishes releases ahead of a timetable change (not checked),
  more routes will have no trips between the publication and the first day. The right
  answer is to keep both and cut the old calendar off the day before the new one starts
  (`xlsx2gtfs`).
