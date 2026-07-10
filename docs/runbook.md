# Runbook

How to operate the live Marquee system. Fill this in as services come online.

## Services & ports

| Service       | Host        | Port          | Start                                         |
| ------------- | ----------- | ------------- | --------------------------------------------- |
| Curator       | workstation | 4739          | `pnpm --filter @marquee/curator dev`          |
| Hue Conductor | Pi 5        | 4737          | systemd: `marquee-conductor`                  |
| Backdrop      | Pi 5        | 4740          | systemd: `marquee-backdrop` (+ Chromium unit) |
| Stylus        | Pi Zero 2 W | 4741 (status) | systemd: `marquee-stylus`                     |

## Common operations

- **Pair the Hue bridge:** on the Pi, `pnpm --filter @marquee/hue-conductor pair`, press the
  bridge link button when prompted.
- **Force a service back to idle:** `curl -X POST http://<host>:<port>/api/admin/stop` (Backdrop)
  / `/api/playback/stop` (Conductor).
- **Re-sync a stuck album:** Curator → album detail → resync, or `POST /api/backdrop/sync-media`.
- **Check logs:** `journalctl -u marquee-<service> -f` on the Pi.

## Failure modes

See `docs/specs/runtime-overview.md §9` for the full table.
