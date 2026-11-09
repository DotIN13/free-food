# Brief: list each university's units, and say which ones we read

free.food (folder `apps/free-food`) scrapes university event feeds for free food. Its feeds are in `sources/*.json`
(several files; the same university `id` can appear in more than one, and they are merged by id). We want to know what
we are **missing**, so each university gets a list of its units (schools, departments, institutes, centers, student
bodies) and each unit says whether we read it.

For every university in your task, write `units/<id>.json` (use the Write tool; touch no other file):

```json
{
  "id": "stanford",
  "name": "Stanford University",
  "wide": ["https://events.stanford.edu"],
  "units": [
    { "id": "law", "name": "Stanford Law School", "kind": "school", "url": "https://law.stanford.edu",
      "feeds": ["https://law.stanford.edu/wp-json/tribe/events/v1/events"], "status": "feed" },
    { "id": "engineering", "name": "School of Engineering", "kind": "school", "url": "https://engineering.stanford.edu",
      "status": "in-wide", "note": "posts its events to events.stanford.edu" },
    { "id": "cs", "name": "Computer Science", "kind": "department", "parent": "engineering", "url": "https://cs.stanford.edu",
      "status": "in-wide" },
    { "id": "gsb", "name": "Graduate School of Business", "kind": "school", "url": "https://www.gsb.stanford.edu",
      "status": "no-feed", "note": "events are a search page with no feed" },
    { "id": "hai", "name": "Institute for Human-Centered AI (HAI)", "kind": "institute", "url": "https://hai.stanford.edu",
      "feeds": ["https://hai.stanford.edu/cms/api/collections/events/entries"], "status": "feed" }
  ]
}
```

## Fields

- `wide`: the feed URLs (exactly as written in `sources/*.json`) that cover the whole university: the main calendar,
  the student-organisation platform (Engage, CampusGroups), a campus-wide Trumba or Localist.
- `units`: one entry per unit.
  - `id`: short, lowercase, unique within the university; `name`: as the university writes it.
  - `kind`: `school` (a college or professional school), `department`, `institute`, `center` (a center, lab or
    program with its own events), `student` (student government, graduate council, residential colleges), `library`,
    `museum` or `other` (athletics, health, career center, arts venue).
  - `parent`: the `id` of the school a department or center belongs to, when there is one.
  - `url`: its website.
  - `feeds`: feed URLs from `sources/*.json` that belong to this unit, **copied exactly**. Every non-wide feed in
    `sources/*.json` for the university must appear in exactly one unit's `feeds` (add a unit for it if needed).
  - `status`:
    - `feed`: we read it (its `feeds` is not empty);
    - `in-wide`: its events are on a university-wide calendar we read (it says so, or embeds that calendar, or you saw
      its talks there);
    - `no-feed`: you checked and it lists events only as HTML, or not at all;
    - `blocked`: its site answers 403, a Cloudflare challenge or a login;
    - `unchecked`: listed but not checked.
  - `note`: one short line on why, when the status is not `feed`.

## What to list (about 30–80 units a university)

1. **Every school or college** (all of them; usually 5–20).
2. **Departments**: the big ones in each school, at least: CS, EE/ECE, mechanical, bioengineering, math, statistics,
   physics, chemistry, biology, economics, psychology, political science, history, English, philosophy, sociology.
3. **Institutes and centers** with real event series: AI/data science, energy/climate, public policy, humanities
   center, area studies, entrepreneurship, medicine/public health centers. Prefer ones with a lot of events.
4. **Student bodies**: undergraduate and graduate student government; residential colleges where they run events.
5. Library, museums, career center when they hold events.

Where to find them: the university's "Schools", "Academics → Departments" and "Research centers & institutes" pages,
and Wikipedia's list of the university's schools.

## Status: use what we already know first

- `sources/*.json` has `notes` per university and each `us-inst-*.json` entry notes what was tried and why it failed
  (403, HTML only, duplicates the main calendar). Use those for `status` and `note` without re-checking.
- For the remaining units, check the **schools and the biggest ~15 departments/institutes** quickly (one or two
  requests each, `curl -sL -m 15 -A "free.food-bot/1.0"`): does its events page say it pulls from the main calendar
  (in-wide), offer a feed, or show only HTML? Leave the rest `unchecked`. Do not add new feeds to `sources/`; if you find
  a feed we don't read, give the unit `"status": "unchecked"` and `"found": "<feed url>"` (we will test and add it).
- Never try to get around a 403 or a challenge: that is `blocked`.

Spend about 6–8 minutes per university. Check your file parses (`node -e 'JSON.parse(require("fs").readFileSync("units/<id>.json"))'`)
and that every non-wide feed of the university appears in some unit (a quick node script over `sources/*.json`).

Final reply, short: per university, units listed, how many `feed` / `in-wide` / missing (`no-feed` + `blocked` +
`unchecked`), and any feeds you found that we don't read (`found`).
