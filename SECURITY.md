# Security policy

Marquee is a personal project that runs on a home LAN. There are no hosted instances and no
published releases, so there is only one supported version: `main`.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/dylanleatham/Marquee/security/advisories/new)
rather than in a public issue. I'll acknowledge the report and follow up there.

## Scope and threat model

- Services trust the local network. Service-to-service calls carry a shared `X-Trigger-Secret`,
  which is there to prevent accidents, not to resist an attacker
  ([runtime overview](docs/specs/runtime-overview.md)). Traffic is plain HTTP; nothing here is
  designed to be exposed to the internet.
- Credentials — Spotify, Gemini, Discogs, the Hue bridge application key, the shared secret — live
  in gitignored files (`.env`, `config.toml`, each service's `data/` directory) or in Curator's data
  directory outside the repo. None are committed; `.env.example` holds placeholders only.
