# Runbook — the hosted demo

Operational procedures for <https://careerhq.nickkalas.dev>: deploy, update,
inspect, force a reset, back up, restore, roll back.

Everything below is a command you can paste. Where a command was verified by
running it, it is written the way it was run. Where a value depends on the box
(a path, a container name), it is named explicitly rather than left as a
placeholder — a runbook is read under pressure, and a `<fill-this-in>` is worse
than no runbook at all because it is trusted.

## 0. The shape of the thing

| | |
|---|---|
| Host | Hetzner CX23, `ssh hetzner-staging` (IPv4 `167.233.94.188`) — **shared** with the owner's other live services |
| Checkout | `/home/nick-kalas/apps/careerhq` |
| Compose project | `careerhq` (set by `name:` in the base compose file — not derived from the directory) |
| Compose files | `infra/docker-compose.yml` **plus** `infra/docker-compose.demo.yml` **plus** `infra/docker-compose.edge.yml` — all three, on this box |
| Env file | `infra/.env`, copied from `infra/demo.env.example` |
| Published port | **none.** The demo overlay alone would publish `127.0.0.1:3100`; the edge overlay removes it, because the proxy reaches the container directly |
| Public entry | the box's existing `edge-nginx` terminates TLS on 443 and proxies to `http://careerhq-web:3000` over the shared external `edge` network |
| TLS | self-signed origin cert `~/infra/edge/certs/careerhq-selfsigned.{pem,key}` (key `0600`, valid to 2036-08-01), with the `nickkalas.dev` zone on Cloudflare **Full**, not Full (strict) — see the vhost's own comment for why |
| Volumes | `careerhq_pgdata` (Postgres), `careerhq_files` (CVs, screenshots, message bodies) |
| Containers | `careerhq-postgres-1`, `careerhq-mailpit-1`, `careerhq-demo-ats-1`, **`careerhq-web`** (fixed name — the vhost proxies to it), `careerhq-worker-1` |

**The neighbours matter.** The same box runs `edge-nginx` on 80/443, kelevo-tms
staging (api + postgres + redis), outreach, iwd-backend and twilio-app on
3.7 GB of RAM. CareerHQ is the guest. Never restart or reconfigure a
neighbouring container, and never reload nginx without `nginx -t` passing first
— a broken reload takes every site on the box down, not just this one.

### The command prefix

Every compose command in this document needs all three files **on the VPS**. Set
this once per shell and the rest of the runbook reads cleanly:

```bash
cd /home/nick-kalas/apps/careerhq
dc() { docker compose \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.demo.yml \
  -f infra/docker-compose.edge.yml "$@"; }
```

Drop the third `-f` anywhere there is no `edge` network — a laptop, a fresh box —
or compose refuses with *"network edge declared as external, but could not be
found"*. That is why it is a separate file rather than part of the demo overlay.

Omitting the second `-f` is the single most likely mistake here, and it is a
dangerous one: the base file alone publishes Postgres, Mailpit and `demo-ats` on
`0.0.0.0` and leaves `DEMO_MODE` false. If a command ever seems to want a port
that should not exist, check the prefix first.

## 1. First deploy

```bash
ssh hetzner-staging
git clone https://github.com/Olorin4/careerhq.git /home/nick-kalas/apps/careerhq
cd /home/nick-kalas/apps/careerhq
cp infra/demo.env.example infra/.env       # optional: every value in it has a default

# Sanity-check the resolved configuration BEFORE anything starts. This is the
# audit: both live gates false, both allow-lists internal, AI_MODE replay, no
# OPENROUTER_API_KEY at all.
dc config | grep -E 'SUBMISSIONS_LIVE|SANDBOX_|DEMO_MODE|AI_MODE|OPENROUTER'

# Schema. Nothing else in this repo migrates the demo database — the worker
# does not run migrations at boot, and there is no host toolchain on the box.
dc --profile tools run --rm migrate

# Build and start. First build pulls ~2.5 GB of Playwright base image.
dc up -d --build

# Wait for health. `web`'s healthcheck asks only "is the HTTP server
# answering"; it does not judge the database.
dc ps
curl -skI -H 'Host: careerhq.nickkalas.dev' https://127.0.0.1/overview | head -1   # through the edge; no host port exists
```

The worker seeds the demo workspace itself, once at boot and again on
`DEMO_RESET_CRON`. **There is no separate seed step** — `pnpm seed` is the local
development path and seeds a *personal* workspace, which is not what the demo
serves.

Then the edge vhost (`infra/edge/careerhq.nickkalas.dev.conf` → the box's
`~/infra/edge/conf.d/`) and the DNS record. Both are covered in the deploy task;
the only rule that must never be skipped:

```bash
docker exec edge-nginx nginx -t     # MUST pass
docker exec edge-nginx nginx -s reload
```

## 2. Update to a new commit

```bash
cd /home/nick-kalas/apps/careerhq
git pull

# Migrations first, and only if there are new ones. Running it when there are
# none is harmless — drizzle-kit applies nothing and exits 0.
dc --profile tools run --rm migrate

dc up -d --build
dc ps
curl -skI -H 'Host: careerhq.nickkalas.dev' https://127.0.0.1/overview | head -1   # through the edge; no host port exists
```

Two notes that save an outage:

- **`--build` is not optional.** The images are built from the checkout, not
  pulled; without it `git pull` changes nothing that is running.
- **Migrate before `up`, not after.** The new `web` starts serving immediately;
  a schema it expects and does not find is a 500 on every page for however long
  the migration takes.

The build is not zero-downtime — `up -d --build` recreates `web` after the image
is built, so expect a few seconds of 502 from the edge. For a demo that is
acceptable; say so rather than pretending otherwise.

## 3. Inspect: logs, health, state

```bash
dc ps                                  # what is up, and whether web is healthy
dc logs -f --tail=100 worker           # the reset, the ingest cron, the email sync
dc logs -f --tail=100 web              # request-path errors, rate-limit refusals
dc logs --since 1h worker | grep demo.reset

# Resource footprint — the number the owner actually cares about on a shared box
docker stats --no-stream $(dc ps -q)
free -h
df -h /

# Into the database. There is no published Postgres port; this is the only way.
dc exec postgres psql -U careerhq -d careerhq
```

Useful one-liners inside `psql`:

```sql
-- the demo workspace and how much is in it. There must be exactly one, and it
-- must be kind = 'sandbox'.
select id, name, kind, created_at from workspaces;
select count(*) from applications;
-- the schedules this worker registered. `demo.reset` appears here ONLY in demo
-- mode, which makes this the fastest check that the overlay is really applied.
select name, cron from pgboss.schedule;
-- cron-fired and manually enqueued resets. Note this table is empty of
-- demo.reset on a freshly started stack and that is correct: the boot reset
-- calls the job function directly rather than going through the queue, and
-- pg-boss moves completed rows to pgboss.archive. The worker log is the record
-- of the boot reset, not this table.
select name, state, created_on, completed_on from pgboss.job
  where name = 'demo.reset' order by created_on desc limit 5;
select name, state, created_on from pgboss.archive
  where name = 'demo.reset' order by created_on desc limit 5;
```

Logs are capped at 10 MB × 3 files per service in the overlay, so `docker logs`
never grows without bound — but it also means anything older than a few hundred
megabytes of output is gone. Nothing here depends on log retention.

## 4. Force a reset

The reset wipes and reseeds the sandbox workspace inside one transaction holding
`pg_advisory_xact_lock`. It is scoped to `kind = 'sandbox' AND name = 'CareerHQ
Demo'` and cannot touch a personal workspace.

**The simple way — restart the worker.** It runs one reset at boot:

```bash
dc restart worker
dc logs --tail=20 worker | grep 'demo.reset'
# [worker] demo.reset (boot) { workspaceId: '…', durationMs: … }
```

**Without bouncing the process — enqueue the job the schedule would have
enqueued.** The running worker picks it up within its polling interval:

```bash
dc exec -w /app/apps/worker worker node --input-type=module -e "
import PgBoss from 'pg-boss';
const boss = new PgBoss(process.env.DATABASE_URL);
await boss.start();
console.log('queued', await boss.send('demo.reset', {}));
await boss.stop();
"
dc logs --tail=20 worker | grep 'demo.reset'
```

`-w /app/apps/worker` is load-bearing: pnpm does not hoist, so `pg-boss`
resolves from the worker package's own `node_modules` and nowhere else.

If neither prints anything, check that demo mode is actually on — the
`demo.reset` queue is registered *only* when `DEMO_MODE=true`, and the worker
`unschedule`s it when it is not:

```bash
dc exec worker env | grep DEMO_MODE
```

## 5. Backup

Two artifacts, and both are needed: the database, and the file volume the
database's paths point into. A dump without the files restores an app whose
CVs and screenshots 404.

```bash
mkdir -p /home/nick-kalas/backups/careerhq
cd /home/nick-kalas/apps/careerhq
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
B=/home/nick-kalas/backups/careerhq

# 1. Postgres — custom format, so pg_restore can be selective later.
dc exec -T postgres pg_dump -U careerhq -d careerhq --format=custom --no-owner \
  > "$B/careerhq-$STAMP.dump"

# 2. The file volume, through a throwaway container (the volume has no host path
#    you should be poking at directly).
docker run --rm \
  -v careerhq_files:/data:ro \
  -v "$B:/backup" \
  alpine tar czf "/backup/careerhq-files-$STAMP.tar.gz" -C /data .

ls -lh "$B"
```

`-T` on `dc exec` is required: without it Compose allocates a TTY and the dump
arrives corrupted by CR translation. This is the classic way to produce a backup
that only fails when you restore it.

Verify the dump is readable rather than assuming it:

```bash
pg_restore --list "$B/careerhq-$STAMP.dump" | head
tar tzf "$B/careerhq-files-$STAMP.tar.gz" | head
```

For the hosted demo specifically, a backup is a convenience, not a safety net —
everything in it is either fictional or re-fetchable, and all of it is
regenerated every six hours. (The discovery inbox holds real public job
listings, not seeded ones — see [`SECURITY.md`](../SECURITY.md#the-hosted-demo)
— but `discovery.ingest` re-pulls them from the feeds on the next cron, so a
lost copy costs nothing.) It matters for a **self-hosted personal install**,
where the same two commands (minus the demo overlay) are the whole backup story.

## 6. Restore

```bash
cd /home/nick-kalas/apps/careerhq
B=/home/nick-kalas/backups/careerhq
STAMP=20260804T235959Z          # the one you are restoring

# Stop the writers. Postgres stays up — it is the restore target.
dc stop web worker

# 1. Database. --clean --if-exists drops and recreates each object, so this
#    works onto a populated database as well as an empty one.
dc exec -T postgres pg_restore -U careerhq -d careerhq --clean --if-exists --no-owner \
  < "$B/careerhq-$STAMP.dump"

# 2. Files. Wipe first: tar extraction merges, it does not replace, so without
#    the rm you get the union of two states rather than the one you asked for.
docker run --rm \
  -v careerhq_files:/data \
  -v "$B:/backup:ro" \
  alpine sh -c 'rm -rf /data/* && tar xzf "/backup/careerhq-files-'"$STAMP"'.tar.gz" -C /data'

dc start web worker
dc ps
curl -skI -H 'Host: careerhq.nickkalas.dev' https://127.0.0.1/overview | head -1   # through the edge; no host port exists
```

`pg_restore --clean` prints errors for objects it cannot drop cleanly, and a
non-zero exit is normal. On this schema they are pg-boss's partition tables
(`ALTER TABLE ... pgboss.j<hash> DROP CONSTRAINT`) — six of them in the verified
run, all noise. What matters is the row counts afterwards:

```bash
dc exec -T postgres psql -U careerhq -d careerhq \
  -c "select (select count(*) from applications) as applications,
             (select count(*) from candidate_facts) as facts,
             (select count(*) from jobs) as jobs;"
```

Verified end to end on a real stack while writing this: dump → delete every
application and event row → restore → the ten seeded applications are back.

## 7. Rollback

**Code.** The images are built from the checkout, so rolling back is checking
out the previous commit and rebuilding:

```bash
cd /home/nick-kalas/apps/careerhq
git log --oneline -10                  # find the last good commit
git checkout <sha>                     # detached HEAD is fine and honest here
dc up -d --build
dc ps && curl -skI -H 'Host: careerhq.nickkalas.dev' https://127.0.0.1/overview | head -1
```

To return to the branch afterwards: `git checkout main && dc up -d --build`.

**Schema.** There are no down-migrations — `drizzle-kit` only rolls forward.
If the bad commit added a migration, rolling the code back leaves a schema
*ahead* of the code. Usually harmless (added columns the old code ignores), and
occasionally not (a new `NOT NULL` the old insert path does not fill). If it is
not harmless, the schema rollback is a restore from §6, not a migration.

**Whole-stack panic button.** Stops CareerHQ and leaves the neighbours alone:

```bash
dc down                # containers and network; volumes survive
dc down --volumes      # ALSO deletes careerhq_pgdata and careerhq_files
```

`dc down` is safe. `dc down --volumes` deletes the database, so coming back up
needs the schema again — `dc --profile tools run --rm migrate` **before**
`dc up -d`, or every page 500s until you do. On the demo the data itself is
recoverable (the worker reseeds at boot); on a personal install it is not.
Know which one you are on before typing it.

## 8. Confirming the safety posture on the live box

Run this after any deploy or update. It is the whole reason the demo is allowed
to be public:

```bash
# Both live gates false, both allow-lists internal
dc exec web env | grep -E 'SUBMISSIONS_LIVE|SANDBOX_'
dc exec worker env | grep -E 'SUBMISSIONS_LIVE|SANDBOX_'

# No model key at all — absent, not empty
dc exec web env | grep OPENROUTER || echo "no OPENROUTER_* in web: correct"

# Replay mode, pointed at the committed fixtures
dc exec web env | grep AI_

# Only web is published, and only on loopback
docker ps --filter label=com.docker.compose.project=careerhq \
  --format '{{.Names}}\t{{.Ports}}'

# Mailpit and demo-ats are not reachable from outside
curl -sS --max-time 5 http://167.233.94.188:8025/ || echo "mailpit unreachable: correct"
curl -sS --max-time 5 http://167.233.94.188:3001/ || echo "demo-ats unreachable: correct"

# The reset is scheduled
dc exec -T postgres psql -U careerhq -d careerhq -c "select name, cron from pgboss.schedule;"
```

`CAREERHQ_MASTER_KEY` **is** present in the demo's environment, and that is
correct — it is the deliberately public key documented in
[`SECURITY.md`](../SECURITY.md). It seals one fictional Mailpit password. It
must never appear anywhere else.

## 9. Troubleshooting

**`web` is unhealthy or every page 500s.** Almost always the database: either
the migration was not run, or Postgres is not up.

```bash
dc logs --tail=50 web
dc ps postgres
dc --profile tools run --rm migrate
```

**Auto-apply refuses every confirmation with `driver_unavailable`.** The `web`
image is built on the Playwright base precisely so Chromium is present; this
means the browser failed to launch. Usually `/dev/shm` or memory:

```bash
dc logs --tail=50 web | grep -i chromium
docker stats --no-stream careerhq-web
```

The overlay sets `shm_size: 256m` on `web` and `worker`. If that was lost, a tab
crashes mid-capture.

**A container was OOM-killed.** Expected behaviour under the hard caps, and
preferable to pushing a neighbour into swap:

```bash
docker inspect careerhq-web --format '{{.State.OOMKilled}} {{.State.ExitCode}}'
```

The budget is 900 (web) + 1200 (worker) + 400 (postgres) + 128 + 128 = 2756 MB
worst case on a 3.7 GB box. Do not raise a `mem_limit` without redoing that
arithmetic against `free -h`.

**Disk filling.** The demo's own ceilings (64 MB of CVs, 64 MB of screenshots)
are enforced in the app, so growth is almost always images. Discovery is not a
third source of growth despite inserting hundreds of rows a cycle: ingested
listings land in the demo workspace, and the reset deletes that workspace row,
cascading to `jobs`, `companies` and `ingest_runs`. Measured against the real
feeds — 39 job rows after a reset, 466 after one ingest run inserted 427, 39
after the next. If you want to see it on the box:

```bash
dc exec -T postgres psql -U careerhq -d careerhq \
  -c "select count(*) from jobs" -c "select pg_size_pretty(pg_database_size('careerhq'))"
```



```bash
docker system df
docker image prune -f          # dangling only; safe
docker builder prune -f        # build cache; safe, costs a slower next build
```

**The demo looks stale or empty.** Force a reset (§4). If the reset itself is
failing, the log line says so and the previous demo is intact — the reset is one
transaction, so a failed seed rolls back rather than leaving half a workspace.

## 10. Local rehearsal

Every command above runs identically against a local copy, which is how they
were verified. From a clean clone:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.demo.yml -f infra/docker-compose.edge.yml \
  --profile tools run --rm migrate
docker compose -f infra/docker-compose.yml -f infra/docker-compose.demo.yml up -d --build
curl -skI -H 'Host: careerhq.nickkalas.dev' https://127.0.0.1/overview | head -1   # through the edge; no host port exists
```

The only difference is the edge proxy and the DNS name. Rehearse a restore
locally before you ever need one on the box.
