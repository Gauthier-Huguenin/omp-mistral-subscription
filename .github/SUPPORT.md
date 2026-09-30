# Maintained

This repository is actively maintained. Issues and pull requests are triaged
within a few days.

## Scope

`omp-mistral-subscription` is a single-purpose extension: it adds a Mistral
subscription provider (browser sign-in, plan-quota billing) to OMP. It is
not a general Mistral SDK, proxy, or gateway, and it will not grow one.

## Compatibility

| Component | Policy |
| --- | --- |
| OMP extension API | Target the current stable OMP; fix breaks within a reasonable window. The extension uses only stable surfaces (`registerProvider`, `registerCommand`) documented in OMP's `extensions.md`. |
| Mistral sign-in flow | Mirrors the Vibe Code CLI. When Mistral changes it, expect a patch release quickly, since the login breaks for everyone at once. |
| Model roster | Follows what the plan actually serves (verified via `GET /v1/models`). Deprecated models are removed rather than kept broken. |

## Release policy

- Semantic versioning: `MAJOR.MINOR.PATCH`. Model roster changes and sign-in
  flow fixes are `MINOR`; internal fixes are `PATCH`.
- No release schedule: releases follow need, not a calendar.

## Ownership

Maintained by [Gauthier Huguenin](https://github.com/Gauthier-Huguenin).
Simple, verifiable, well-argued PRs from anyone are merged; the maintainer
breaks ties on direction. If the maintainer becomes inactive for a
sustained period, the MIT license permits any fork to continue the work.
