# Fixline

**An IT help desk that feels instant.** A live ticket queue with time limits that pause on their own, fixes suggested while people type, one-click outage banners, and a simple portal for employees.

![CI](https://github.com/Hanee2907/fixline/actions/workflows/ci.yml/badge.svg)

Big enterprise service desks can do almost anything, but the everyday moments (reporting a problem, finding a known fix, keeping an eye on time limits) are often slow and full of forms. Fixline is built around those moments.

## For employees

- **One box: "What's going wrong?"** Write it in your own words, with no forms full of dropdowns.
- **Fixes while you type.** Matching knowledge base guides appear as you describe the problem. If one works, there's no ticket at all, and the guide's "fixed 14×" count goes up.
- **Sorted automatically.** Fixline reads the description and picks the category (Email, Network, Access…) and urgency. You see how it will be handled before you send it: *"Network · High · first reply within 30 min"*.
- **Known-issue banner.** During an outage everyone sees *"VPN outage · we're on it"*, so 50 people don't report the same thing.
- **A tracker, like a parcel:** Received → In progress → Fixed → Rated. Rate the fix with one tap, or say it's still broken to reopen it.

## For IT agents

- **Live queue.** New tickets slide in and changes appear on every screen without refreshing (Server-Sent Events).
- **Time limits that are fair.** Each priority has a first-response and a fix target. Countdown bars turn amber, then red. While a ticket waits on the user, a manager or a part, **the clock pauses**, and the deadline moves by exactly the time spent waiting.
- **Suggested fixes** from the knowledge base and from similar solved tickets (PostgreSQL full-text search), inserted into the reply with one click.
- **Saved replies:** type `/` in the reply box.
- **Keyboard first:** `J`/`K` move through the queue, `R` reply, `N` internal note, `A` take the ticket, `E` resolve, `C` new ticket, `Ctrl+K` search everything.
- **Internal notes** that employees never see, enforced by the API, not just hidden in the page.
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
| Live updates | Server-Sent Events with a per-workspace event bus; events carry ids only, so nothing private travels over the stream |
| Database | PostgreSQL, including full-text search for suggestions. Locally it runs on [PGlite](https://pglite.dev) (PostgreSQL in WebAssembly), so there's nothing to install |
| Auth & roles | Employees, agents and admins. scrypt password hashes, random session tokens in httpOnly cookies (only their SHA-256 is stored), every query scoped to the user's workspace |
| Tests | Vitest for logic and the real API against PostgreSQL; Playwright for full browser journeys plus axe accessibility checks in dark and light mode, on desktop and phone |
| Ops | Docker, docker-compose with PostgreSQL, GitHub Actions CI |

### Decisions worth explaining

- **The clock pauses fairly.** Pausing stores when the wait began. Resuming moves both deadlines by the exact time spent waiting, so an agent is never penalised for a part on order.
- **Live updates send ids, not data.** The browser re-fetches what changed through the normal, permission-checked API, so the stream can't leak an internal note or someone else's ticket.
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

In production set `DATABASE_URL` and `PORT`, then `npm run build && npm start`.

---

Made by [Hanee Patel](https://hanee2907.github.io).
