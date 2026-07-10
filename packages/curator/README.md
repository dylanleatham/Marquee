# Curator

Admin app + source of truth for the collection; hosts Roadie. Runs on your workstation.
Fastify API + React/Vite UI. Specs:
[curator](../../docs/specs/curator-spec.md) ·
[roadie](../../docs/specs/roadie-spec.md) ·
[onboarding workflow](../../docs/specs/album-onboarding-workflow.md).

**First milestone (build order step 3):** asset-store read/write + serve via API; hand-create a
stub `{curatorId}.json`, get it back from `GET /api/albums/:curatorId`. Then manual add-album.
