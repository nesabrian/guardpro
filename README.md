# Guard Pro

Guard scheduling, clock-in, reports, patrols, pay and bill for security companies. All five build
phases are in this codebase.

Three apps, one server, no packages to install (Node.js 22.5 or newer with its built-in SQLite):

- **Dispatch board** at `/dispatch/` — dashboard (KPI tiles, needs-attention list, live activity feed), week grid by site or officer, live "On post" view, open-shift board,
  officer requests, reports, dispatcher clock-in/out on an officer's behalf, officers, sites and posts (with checkpoints, tours and patrol settings),
  pay & bill (timesheets, invoices, aging, rates and holidays), patrol routes and runsheets.
- **Officer app** at `/officer/` — a mobile web app officers add to their home screen: my shifts,
  acknowledge, clock in and out with location, post orders, open shifts and pickup requests, drop and swap
  requests, time off and availability, daily and incident reports with photos, checkpoint scanning
  (QR or code), patrol runsheets with GPS trail, lone-worker check-ins, notifications.
- **Client portal** at `/client/` — email-code login for site contacts: coverage with clock-in status,
  checkpoint scan counts, and reports that dispatch has reviewed or sent.

## Run it

```bash
copy config.example.json config.json     # then edit: admin login, company, alert channels, texting
node server/import-tracktik.js --reset    # loads data/import/{employees,sites,weeks}/*.json
node server/index.js                      # http://localhost:8080
node scripts/smoke-test.js                # Phase 1 checks (15)
node scripts/phases-test.js               # Phase 2–5 checks (62), creates and removes its own test data
```

Sign in to the dispatch board with the admin email and password from `config.json`. Officers sign in on
`/officer/` with the mobile number on their record; the six-digit code is texted when `sms` is configured
and shown on screen while it is not (`devShowCodes: true`). Client users are created from the API
(`POST /api/clients`) and receive their code by email.

## What the server does on its own (every minute)

- **Late and missed**: a shift that started `lateAfterMinutes` ago with no clock-in raises a late alert,
  `missedAfterMinutes` a missed alert, to the Slack webhook and email list. Switched on by `alertsEnabled`.
- **Reminders**: texts the evening before and `reminders.hoursBefore` before each published shift.
  Switched on by `remindersEnabled`.
- **Lone worker**: posts with a check-in interval raise an alert when an officer misses a check-in by
  more than `loneGraceMinutes`.
- **Patrol stops**: a runsheet stop whose time window has passed without a visit is marked missed and
  dispatch is notified.

Both alert switches start **off** so a parallel run beside TrackTik does not alert on shifts clocked in
elsewhere.

## Phase by phase

| Phase | What it covers | Where |
|---|---|---|
| 1 | Roster, schedule, publish, clock in/out with geofence, late/missed alerts, reminders | `server/api.js`, `jobs.js` |
| 2 | Open-shift pickups, drop and swap requests, time-off requests, officer availability, notifications | `server/phase2.js` |
| 3 | Daily and incident reports with photos, checkpoints and tours, QR scanning, tour compliance, client portal | `server/phase3.js` |
| 4 | Rates with effective dates, timesheets from clock data with approval, payroll CSV, invoices, credit memos, aging, printable invoice | `server/phase4.js` |
| 5 | Patrol routes, runsheets with arrive/depart and GPS breadcrumbs, patrol reports, lone-worker check-ins | `server/phase5.js` |

## Configuration keys

| Key | Meaning |
|---|---|
| `company`, `companyAddress` | Shown on invoices and in the apps |
| `admin` | First dispatch login, created on start if missing |
| `slack.webhookUrl` | Slack incoming webhook for alerts |
| `email` | `provider` is `resend` or `sendgrid`; `to` is the alert list; also used for report and invoice delivery |
| `sms` | `provider` `twilio` with `accountSid`, `authToken`, `from` |
| `alertsEnabled`, `remindersEnabled` | Both start **off**; turn on once officers clock in through Guard Pro |
| `lateAfterMinutes`, `missedAfterMinutes`, `loneGraceMinutes` | Alert thresholds |
| `geofenceMeters` | Default clock-in radius when a site has none |
| `defaultBillRate`, `defaultPayRate` | Used when no rate matches a post, site or officer |
| `overtimeWeeklyHours`, `roundClockToMinutes` | Payroll rules (40 h weekly OT; clock times rounded to 15 min) |
| `invoiceTermsDays` | Due date offset for generated invoices |

## Hosting

Any host that runs Node works (Railway, Render, Fly, a small VM). Put it behind HTTPS with `baseUrl`
set to the public address so the login cookie is marked secure. Back up `data/guardpro.db` and
`data/uploads/` daily. For a larger deployment the schema in `server/db.js` and the phase modules moves
to PostgreSQL unchanged apart from the driver.

## Layout

```
server/   index.js (http + static), router.js, api.js (core routes), phase2–5.js, dashboard.js, db.js (schema + documents),
          auth.js (logins), jobs.js (alerts + reminders), notify.js (Slack/email/SMS), time.js, import-tracktik.js
web/      dispatch/{index.html, phases.js, dash.js}, officer/{index.html, manifest.webmanifest, sw.js, icon.svg}, client/index.html
scripts/  smoke-test.js, phases-test.js
data/     guardpro.db, uploads/ (photos), import/ (TrackTik snapshot; not committed)
```
