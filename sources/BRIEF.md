# Brief: find machine-readable event feeds for universities

We are building a "free food" event hub. A server scrapes university event calendars every few
hours and flags events that mention free food. Your job: for each university in your list, find
event feeds that the server can fetch with a plain HTTPS GET (no login, no JS rendering), check
each one returns real upcoming events, and write the result to the JSON file named in your task.

## What counts as a feed (in order of preference)

1. `localist` — a Localist calendar. Test: `https://<host>/api/2/events?days=30&pp=1` returns
   JSON with `events` and `page.total`. Hosts look like events.X.edu, calendar.X.edu,
   X.edu/events, happening.X.edu, etc. Record `url` as the origin (`https://events.stanford.edu`).
2. `ical` — an .ics feed (Trumba `https://www.trumba.com/calendars/<name>.ics`, Google Calendar
   public ics, Drupal/WordPress "The Events Calendar" `?ical=1` or `/events/?ical=1`,
   `/events.ics`, `webcal://` links on the calendar page → use https). Must contain VEVENTs with
   DTSTART in the future.
3. `rss` — an RSS/Atom feed of events (Trumba `.rss`, LiveWhale `/live/rss/events`, Drupal
   `/events/feed`). LiveWhale JSON (`/live/json/events`) counts too: record as type `livewhale`
   with the JSON url.
4. `json` — any other open JSON events API (e.g. `/wp-json/tribe/events/v1/events`,
   CampusGroups / Presence / Engage public APIs, 25Live public `25livepub.collegenet.com` json).
   Record type `tribe` for The Events Calendar WP REST API, `json` for others and add a `note`
   saying the shape (where the array is, field names for title/start/location/description).

Student-org platforms (CampusGroups, Anthology Engage/CampusLabs `*.campuslabs.com/engage/api/discovery/event/search`,
Presence) are GOLD: student-org events are where free food lives, and Engage events have a
`benefitNames` field that literally includes "Free Food". Look for them.

Also try 1-3 feeds from research institutes / big departments under the university (e.g. a CS
department, a medical school, an institute like Broad, Hoover, SLAC, Wyss) when they have their
own feed. A university-wide feed is the priority; don't spend more than ~5 minutes per university.

## How to check

Use `curl -sL -m 15 -A "Mozilla/5.0" <url> | head -c 2000` or a small node script. A feed counts
only if it returned upcoming events today. Use WebSearch/WebFetch to find calendar pages
("<university> events calendar ical", "site:<domain> localist"). Don't scrape HTML pages.

## Output: a JSON array, one object per university, in rank order

```json
[
  {
    "id": "stanford",
    "name": "Stanford University",
    "short": "Stanford",
    "country": "US",
    "city": "Stanford, CA",
    "rank": 3,
    "lat": 37.4275, "lng": -122.1697,
    "sources": [
      { "type": "localist", "url": "https://events.stanford.edu", "label": "Stanford Events", "events": 873 },
      { "type": "ical", "url": "https://...ics", "label": "Stanford CS", "institute": true, "events": 40 }
    ],
    "notes": "anything useful, e.g. Engage blocked by Cloudflare"
  }
]
```

`events` is how many upcoming events you saw. `lat`/`lng` is the main campus centre. A
university with no working feed still gets an entry with `"sources": []` and a note on what you
tried. Write the file with the Write tool; don't touch any other file in the app. Your final reply:
how many universities have at least one working feed, and which have none.
