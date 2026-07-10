# @marquee/contracts

The API of the whole system. Every service boundary is a JSON schema in `schemas/`.
Producer and consumer both validate against the same file.

## Schemas

| File                          | Boundary                                            |
| ----------------------------- | --------------------------------------------------- |
| `palette-payload.schema.json` | Palette Press → Conductor (and Curator → Conductor) |
| `scan-event.schema.json`      | Stylus → Conductor, Stylus → Backdrop               |
| `library-entry.schema.json`   | Curator → Backdrop (`library.json`)                 |
| `album-asset.schema.json`     | Curator's on-disk `{curatorId}.json` format         |

## Usage

- **Node/TS services** import types from this package and validate with Ajv/Fastify.
- **Python (Stylus)** reads the same `.json` files directly via `jsonschema`.

## Codegen

`pnpm --filter @marquee/contracts gen` regenerates TS types from the schemas
(`scripts/gen-schemas.mjs`). Regenerate whenever a schema changes.

## Versioning

Add fields freely (both sides ignore unknown fields). Removing/changing a field's
meaning = bump `version` and support both. New pattern types = add to enum;
Conductor rejects unknown types with a 400.
