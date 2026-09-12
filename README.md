# Guard Pro

Guard scheduling, clock-in and dispatch for security companies. Phase 1 build.

Two apps, one server:

- **Dispatch board** at `/dispatch/` — week grid by site or officer, open-shift board, officers, sites and posts, "On post" live view, CSV export.
- **Officer app** at `/officer/` — a mobile web app officers add to their home screen: my shifts, acknowledge, clock in and out with location, post orders.

The server is plain Node.js (22.5 or newer) with its built-in SQLite database. No packages to install.

## Run it

```bash
copy config.example.json config.json     # then edit: admin login, alert channels, texting
node server/import-tracktik.js --reset    # loads data/import/{employees,sites,weeks}/*.json
node server/index.js                      # http://localhost:8080
```

Sign in to the dispatch board with the admin email and password from `config.json`. Officers sign in on
`/officer/` with the mobile number on their record; the six-digit code is texted when `sms` is configured
and shown on screen while it is not (`devShowCodes: true`).

## What the server does on its own

- Every minute: any shift that started `lateAfterMinutes` ago with no clock-in raises a **late** alert;
  after `missedAfterMinutes` a **missed** alert. Alerts go to the Slack webhook and the email list in
  `config.json` and show on the board's "On post" view.
- Text reminders the evening before (`reminders.eveningBeforeHour`) and `reminders.hoursBefore` hours
  before each published shift, when texting is configured.
- Clock-ins record the phone's location and the distance to the site. A site needs `lat`/`lng` (set on the
  site in the dispatch board) for the distance check; the clock-in is flagged when it is outside the
  site's radius (default `geofenceMeters`).

## Hosting

Any host that runs Node works (Railway, Render, Fly, a small VM). Put it behind HTTPS with `baseUrl`
set to the public address so the login cookie is marked secure. Back up `data/guardpro.db` daily. For a
larger deployment the schema in `server/db.js` moves to PostgreSQL unchanged apart from the driver.

## Configuration keys

| Key | Meaning |
|---|---|
| `admin` | First dispatch login, created on start if missing |
| `slack.webhookUrl` | Slack incoming webhook for alerts |
| `email` | `provider` is `resend` or `sendgrid`; `to` is the alert list |
| `sms` | `provider` `twilio` with `accountSid`, `authToken`, `from` |
| `alertsEnabled`, `remindersEnabled` | Both start **off**. Turn on once officers clock in through Guard Pro; while TrackTik is still the clock-in system every shift would look late |
| `lateAfterMinutes`, `missedAfterMinutes` | Alert thresholds |
| `geofenceMeters` | Default clock-in radius when a site has none |

## Layout

```
server/   index.js (http + static), api.js (JSON API + live events), db.js (schema + documents),
          auth.js (logins), jobs.js (alerts + reminders), notify.js (Slack/email/SMS), time.js, import-tracktik.js
web/      dispatch/index.html, officer/{index.html, manifest.webmanifest, sw.js, icon.svg}
data/     guardpro.db (created on first run), import/ (TrackTik snapshot, not committed)
```
