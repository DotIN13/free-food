# free.food

Reads the public event calendars of 70 top universities every 3 hours and shows the events that offer free food:
a map, walking routes, and for every event the calendar it came from.

It runs two ways from the same code:

- **On Vercel** (the public site): a GitHub Actions workflow scrapes every 3 hours and deploys a static site, plus two
  small functions for "Was there food?" votes and source suggestions, which use a Postgres database (Neon).
- **On one Node server** (Node 22.13 or newer, no packages): it scrapes on its own schedule and keeps everything in a
  SQLite file.

## On Vercel, through GitHub Actions

`.github/workflows/scrape-deploy.yml` runs `node scripts/build.mjs --out dist` and deploys `dist/` with the Vercel CLI,
every 3 hours, on every push to `main`, and by hand (Actions → Scrape and deploy → Run workflow).

The build writes:

| File | What it is |
|---|---|
| `data/home.json` | upcoming food events, slimmed to what the home page shows |
| `data/campus/<id>.json` | every upcoming event at one campus, in full |
| `data/universities.json` | campuses, their feeds and each feed's last checks |
| `data/meta.json` | when the site was built and how many feeds worked |
| `data/state.json` | the scraper's memory, read back by the next build from the live site |
| `bot/index.html` | who we are, for the sites we read |

The deploy token is one you make, limited to this project:

    vercel tokens create "free-food GitHub Actions deploy" --project free-food
    gh secret set VERCEL_TOKEN --repo DotIN13/free-food      # paste the token when asked

Until it is set, runs still scrape and list failing feeds, and skip the deploy with a warning.

Repository settings it needs:

- secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
- variables `SITE_URL` (the live address: the build reads its state from there and links `SITE_URL/bot` in its
  User-Agent) and `CONTACT_EMAIL` (put in the User-Agent and `From` header so sites can reach you)

On Vercel, the project needs `DATABASE_URL` (connect a Neon database to it) and, ideally, `VOTE_SALT`
(a long random string). Without a database the site still works; votes and suggestions hide.

## On one server

    cp .env.example .env     # then edit: HOST, TRUST_PROXY, SITE_URL, CONTACT_EMAIL, FRAME_ANCESTORS
    node server.js

or with Docker (data on a volume):

    docker build -t free-food .
    docker run -d -p 8080:8080 -v free-food-data:/app/data --env-file .env free-food

Put it behind HTTPS (Caddy, nginx or your platform's router): browsers only share location over HTTPS.

It keeps `DATA_DIR/free-food.db` (events, feed history, place lookups, votes, suggestions), a daily copy in
`DATA_DIR/backups/` (the last `BACKUP_DAYS` kept), the static site in `DATA_DIR/site/`, and `DATA_DIR/.admin-token`
and `.salt`, made on first start.

Admin calls take `Authorization: Bearer <token>` (from `ADMIN_TOKEN` or `DATA_DIR/.admin-token`):

    curl -X POST -H "authorization: Bearer $T" https://host/api/refresh            # scrape now (?uni=nyu for one campus)
    curl -H "authorization: Bearer $T" https://host/api/admin/suggestions          # links people suggested
    curl -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
         -d '{"status":"added"}' https://host/api/admin/suggestions/12               # mark one
    curl -X POST -H "authorization: Bearer $T" https://host/api/admin/backup       # back up now

`GET /healthz` answers 200 while the data is fresh and 503 otherwise.

## Sources and robots.txt

Feeds are listed in `sources/*.json`. The scraper names itself `free.food-bot` and honours robots.txt
(`RESPECT_ROBOTS=1`), except for feeds marked `"robots"` in their entry, which are read despite a rule for all bots
by the owner's decision. A rule written for `free.food-bot` by name is always obeyed. When a university gives
permission for a feed, add `"permission": "who agreed, and when"` to its entry.
