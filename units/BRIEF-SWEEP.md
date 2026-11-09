# Brief: check every "unchecked" unit, and find the feeds we're missing

Read `units/BRIEF.md` first: it explains the units files (`units/<id>.json`) and the statuses. Each university's file
lists its schools, departments, institutes and student bodies; many are still `"status": "unchecked"`. Your job: for
every unchecked unit in your universities, find out what it is, and write the answer into that university's file.

For each unchecked unit:
1. Open its events page (its `url`, then `/events`, `/news-events/events`, `/calendar`, or the link on its home page).
   One to four requests, `curl -sL -m 15 -A "free.food-bot/1.0"`. Never get around a 403 or a challenge.
2. Decide:
   - it pulls or embeds the university-wide calendar, or its events appear there → `in-wide`;
   - it offers a feed (iCal `?ical=1` / `.ics` / `calendar.ics`, The Events Calendar `/wp-json/tribe/events/v1/events`,
     LiveWhale `/live/json/events/`, Localist `/api/2/events`, Trumba `.ics`, LibCal `ical_subscribe.php`, an RSS whose
     items are events with event dates in them, Drupal JSON:API) → test it with our reader (below); if it returns upcoming
     events, set `"found": "<feed url>"` and keep `unchecked` (I add it to sources); if it returns nothing upcoming, `no-feed`
     with a note;
   - events only as HTML, or none → `no-feed`; 403, Cloudflare/Incapsula/Azure challenge or login → `blocked`.
3. Add a short `note` saying why (except for `found`).
4. Put the test result on the unit when you set `found`: `"foundEvents": <upcoming>, "foundFood": <with food>`.

If the unit's `url` is wrong or a guess, fix it. If a unit doesn't exist (merged, renamed), fix its name or remove it,
unless it owns `feeds`.

Test a feed with our code, from the folder `apps/free-food`:

```bash
node /tmp/fftest.mjs '[{"type":"ical","url":"https://...","tz":"America/New_York"}]'
```
It prints `upcoming  with-food  read  url  first-event`. Types: ical, tribe, livewhale, localist, rss, json (json needs
`"fields"`; see BRIEF-INSTITUTES.md in sources/). Use the university's time zone.

Rules: write only your universities' `units/<id>.json` files (Write tool, or a short script); don't touch `sources/`,
`lib/` or other files. Keep every existing `feeds` entry where it is. Check each file still parses, then run
`node scripts/coverage.mjs <id>` and make sure it reports 0 feeds unclaimed.

Budget: about 1 request-minute per unit; skip ahead when a whole school's departments clearly share one setup (e.g. all
embed the main calendar: mark them together). Final reply, short: per university, unchecked before → after, and the
`found` feeds with their counts.
