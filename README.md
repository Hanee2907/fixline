# Fixline

**An IT help desk that feels instant.** A live ticket queue with time limits that pause on their own, fixes suggested while people type, one-click outage banners, and a simple portal for employees.

![CI](https://github.com/Hanee2907/fixline/actions/workflows/ci.yml/badge.svg)

Big enterprise service desks can do almost anything, but the everyday moments (reporting a problem, finding a known fix, keeping an eye on time limits) are often slow and full of forms. Fixline is built around those moments.

## For employees

- **One box: "What's going wrong?"** Write it in your own words, with no forms full of dropdowns.
- **Fixes while you type.** Matching knowledge base guides appear as you describe the problem. If one works, there's no ticket at all, and the guide's "fixed 14×" count goes up.
- **Sorted automatically.** Fixline reads the description and picks the category (Email, Network, Access…) and urgency. You see how it will be handled before you send it: *"Network · High · first reply within 30 min"*.
- **Known-issue banner.** During an outage everyone sees *"VPN outage · we're on it"*, so 50 people don't report the same thing.
- **Screenshots and files.** Paste a screenshot with Ctrl+V, drag it in, or use 📎. Images show right in the conversation.
- **Email both ways.** Emailing the desk opens a ticket; people get an email when it arrives, when IT replies and when it's fixed, and simply replying to that email adds to the ticket (the `[FX-1048]` tag in the subject finds it, and quoted history is trimmed off).
- **A tracker, like a parcel:** Received → In progress → Fixed → Rated. Rate the fix with one tap, or say it's still broken to reopen it.
- **Forgot password:** a single-use link that expires in 30 minutes and signs out every other session.

## For IT agents

- **Live queue.** New tickets slide in and changes appear on every screen without refreshing (Server-Sent Events).
- **Time limits that are fair.** Each priority has a first-response and a fix target. Countdown bars turn amber, then red.
  - **Working hours:** admins set the time zone, days and opening hours. Clocks only count while the desk is open (a ticket from Friday evening starts on Monday morning) and show ☾ after hours. Urgent P1 tickets can keep running 24/7.
  - **Pausing:** while a ticket waits on the user, a manager or a part, the clock stops; it resumes with exactly the working time that was left.
- **Suggested fixes** from the knowledge base and from similar solved tickets (PostgreSQL full-text search), inserted into the reply with one click.
- **Saved replies:** type `/` in the reply box.
- **Keyboard first:** `J`/`K` move through the queue, `R` reply, `N` internal note, `A` take the ticket, `E` resolve, `C` new ticket, `Ctrl+K` search everything.
- **Internal notes** that employees never see, including files attached to them, enforced by the API, not just hidden in the page.
- **Outbox:** every email the desk sent, with its delivery status.
- **Turn a fix into a guide** while resolving, so the knowledge base grows by itself.
- **Incidents:** declare one, link duplicate tickets, then resolve them all at once; every person who reported it gets the update.
- **Reports:** on-time rate, first-response time, satisfaction, volume, common problems, team workload, and the guides that fix the most.
- **Dark and light mode**, and a layout that works on a phone.

## Try it

**Live demo:** *coming soon.* "Try it as IT staff" and "Try it as an employee" create a throwaway desk full of realistic tickets. Switch between the two views with one click and watch changes appear live.

## How it's built

| Layer | What |
|---|---|
| Web | React 19, TypeScript 7, Vite 8 |
| API | Node.js 26, [Hono](https://hono.dev), Zod 4 validation on every request |
| Live updates | Server-Sent Events, fanned out through PostgreSQL `LISTEN/NOTIFY`, so any number of servers stay in sync with no extra message broker; "agents online" uses a shared presence table with a heartbeat |
| Files | Stored in PostgreSQL. The type is decided from the file's bytes, not its name: PNG, JPEG, GIF, WebP, PDF and plain-text logs only (no SVG or HTML, which can carry scripts), 5 MB each, served with `nosniff` and a sandboxing CSP |
| Email | Nodemailer over any SMTP service; an inbound webhook (the shape Postmark, SendGrid and Mailgun use) turns emails into tickets and replies |
| Working hours | Time-zone maths with the built-in `Intl` API, daylight-saving safe, with tests for weekends and DST |
| Database | PostgreSQL, including full-text search for suggestions. Locally it runs on [PGlite](https://pglite.dev) (PostgreSQL in WebAssembly), so there's nothing to install |
| Auth & roles | Employees, agents and admins. scrypt password hashes, random session tokens in httpOnly cookies (only their SHA-256 is stored), every query scoped to the user's workspace |
| Tests | Vitest for logic and the real API against PostgreSQL; Playwright for full browser journeys plus axe accessibility checks in dark and light mode, on desktop and phone |
| Ops | Docker, docker-compose with PostgreSQL, GitHub Actions CI |

### Decisions worth explaining

- **The clock pauses fairly.** Pausing stores when the wait began. Resuming moves both deadlines by the exact time spent waiting, so an agent is never penalised for a part on order.
- **Live updates send ids, not data.** The browser re-fetches what changed through the normal, permission-checked API, so the stream can't leak an internal note or someone else's ticket.
- **Several servers, one source of truth.** Sessions, files, presence and events all live in PostgreSQL, so you can run as many copies of the server as you like behind a load balancer.
- **Password reset that leaks nothing.** The answer is the same whether or not an email has an account, tokens are stored only as hashes, the outbox never keeps the link, and resetting ends every other session.
- **One database engine everywhere.** The same SQL (including full-text search) runs on PGlite on a laptop and in tests, and on PostgreSQL in CI and production.
- **Security basics:** JSON-only writes (blocks cross-site form posts), rate-limited sign-in, strict field validation, secure headers, workspace isolation tested in the API suite.

## Run it

Needs Node.js 22.12 or newer.

```bash
npm install
npm run dev        # web on http://localhost:5192, API on :8790, data in .data/
npm test           # unit + API tests
npm run test:e2e   # browser + accessibility tests on the production build
```

With Docker and PostgreSQL:

```bash
docker compose up  # http://localhost:8080
```

In production set:

| Variable | What |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Port to listen on |
| `APP_URL` | Public address, used in email links (e.g. `https://fixline.example.com`) |
| `SMTP_URL` | Optional. Any SMTP service, e.g. `smtp://user:pass@smtp.example.com:587`. Without it, emails are kept in the outbox and reset links are printed to the server log |
| `MAIL_FROM` | Optional sender, e.g. `IT Help Desk <help@example.com>` |

Then `npm run build && npm start`. For email into the desk, point your provider's inbound webhook at the address shown under **Settings & email**.

---

Made by [Hanee Patel](https://hanee2907.github.io).
