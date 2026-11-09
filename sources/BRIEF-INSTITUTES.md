# Brief: find more event feeds inside each US university (institutes, centers, schools, departments)

free.food scrapes university event calendars and flags events that offer free food. Today each university has 1–3
feeds (its main calendar and student-org platform). Many events with food never reach those: institute talks, school
seminars ("lunch provided"), center receptions. Example: Stanford HAI's events are only on hai.stanford.edu, read through
its Statamic API. Your job: for each university in your list, find feeds from its **institutes, centers, professional
schools and big departments** that the scraper can read, verify them with our own code, and write them to the JSON file
named in your task.

## Where to look (most free food first)

- AI / data / computing institutes and big research centers (e.g. HAI, CSAIL, Schwarzman College, Berkeley BAIR/Simons,
  CMU AI, Princeton AI Lab)
- Professional schools: business, law, public policy, medicine and public health, engineering, education
- Big departments with weekly seminar series: CS, EE, statistics, economics, physics, biology
- Humanities centers, area-studies institutes, entrepreneurship centers, graduate student councils, residential colleges
- A school-wide calendar that is separate from the main one (e.g. a medical school's own Localist or Trumba)

## Feed kinds our scraper reads (set `type`)

- `localist` — origin of a Localist calendar (`/api/2/events` works)
- `ical` — any .ics / webcal (Trumba `/calendars/<name>.ics`, Drupal `/calendar/ical`, `/events.ics`, Google Calendar
  public ics, The Events Calendar `?ical=1`)
- `rss` — RSS/Atom of events (Drupal `/events/feed`, `/rss.xml` when it lists events with dates in the text)
- `livewhale` — LiveWhale JSON, e.g. `https://events.x.edu/live/json/events/group/<Group Name>` (groups are cheap wins:
  LiveWhale universities expose one feed per department)
- `tribe` — WordPress The Events Calendar REST API (`/wp-json/tribe/events/v1/events`)
- `statamic` — Statamic REST API, `https://site/cms/api/collections/<events>/entries` (try it on modern CMS sites)
- `engage` — Anthology Engage discovery API (already covered for most schools)
- `json` — any other open JSON events endpoint; add `"fields": { "list", "title", "start", "end", "location", "desc", "url" }`
  as dotted paths, and a `note` describing it

No HTML scraping and nothing behind a login. If a site has events only as HTML or inside a JavaScript app, note it in
`notes` (one line) and move on.

## Verify every feed with our own code (from the folder `apps/free-food`)

```bash
node --input-type=module -e '
const { FETCHERS, kindOf } = await import("./lib/scrape.js");
const { foodOf } = await import("./lib/food.js");
const src = { type: "ical", url: "https://...", tz: "America/New_York" };
const ev = await FETCHERS[kindOf(src)](src);
const now = Date.now(), up = ev.filter((e) => { const t = Date.parse(e.start); return t > now - 6*36e5 && t < now + 21*864e5; });
const food = up.filter((e) => foodOf(e) && foodOf(e).level !== "maybe");
console.log(ev.length, "read;", up.length, "upcoming;", food.length, "with food"); for (const e of up.slice(0,3)) console.log(e.start, e.title);
'
```

A feed counts only if it returns upcoming events (next 3 weeks) with correct dates. Don't add a feed already listed in
`sources/*.json` (read them first), and skip one whose events all already appear in the university's main feed (compare a
few titles). Food matters: prefer feeds where `food` > 0, but a feed of talks with no food words yet is still worth adding
if it has many upcoming events.

Be polite: a handful of requests per site, `curl -sL -m 15 -A "free.food-bot/1.0"`. Spend about 5 minutes per university;
aim for 2–6 good feeds each.

## Output: a JSON array, one object per university you added feeds for

```json
[
  {
    "id": "stanford",
    "name": "Stanford University",
    "sources": [
      { "type": "statamic", "url": "https://hai.stanford.edu/cms/api/collections/events/entries", "label": "Stanford HAI (Human-Centered AI)", "institute": true, "events": 14, "food": 1 }
    ],
    "notes": "one line on what you tried that did not work"
  }
]
```

Use the **same `id`** as the university's entry in `sources/us-1.json` or `us-2.json` (the files are merged by id).
`label` names the institute or school as a person would. Write the file with the Write tool; touch no other file. Your
final reply: feeds added per university, total upcoming events and food events they add, and notable places with no feed.
