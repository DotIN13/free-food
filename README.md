# free.food

Reads the public event calendars of 70 universities every 3 hours and shows the events that offer free food.
One Node process (22.13 or newer), no packages. Data lives in one SQLite file under `DATA_DIR`.

## Run it

    cp .env.example .env     # then edit: HOST, TRUST_PROXY, CONTACT_URL, FRAME_ANCESTORS
    node server.js

or with Docker (data on a volume):

    docker build -t free-food .
    docker run -d -p 8080:8080 -v free-food-data:/app/data --env-file .env free-food

Put it behind HTTPS (Caddy, nginx or your platform's router): browsers only share location over HTTPS.

## What it keeps

`DATA_DIR/free-food.db`: events, feed status and check history, place lookups, votes, suggestions.
`DATA_DIR/backups/`: a copy of the database each day, the last `BACKUP_DAYS` kept. Copy these off the machine.
`DATA_DIR/.admin-token`, `.salt`: made on first start, readable only by the server's user. Don't commit them.

## Admin (Bearer token from ADMIN_TOKEN or DATA_DIR/.admin-token)

    curl -X POST -H "authorization: Bearer $T" https://host/api/refresh            # scrape now (?uni=nyu for one campus)
    curl -H "authorization: Bearer $T" https://host/api/admin/suggestions          # links people suggested
    curl -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
         -d '{"status":"added"}' https://host/api/admin/suggestions/12               # mark one
    curl -X POST -H "authorization: Bearer $T" https://host/api/admin/backup       # back up now

`GET /healthz` answers 200 while the data is fresh (under two refresh periods old) and 503 otherwise: point your uptime monitor at it.

## Sources and robots.txt

Feeds are listed in `sources/*.json`. Every feed's robots.txt is honoured (`RESPECT_ROBOTS=1`). When a university gives
permission for a feed its robots.txt disallows, add `"permission": "who agreed, and when"` to that source entry.
