<div align="center">

# omp-mistral-subscription

**Use your Mistral Vibe subscription in [OMP](https://github.com/can1357/oh-my-pi).**

Browser sign-in on `console.mistral.ai`, then code with every chat model your
plan serves — Mistral Medium, Large 4, Codestral, Devstral, plus Z.ai GLM and
DeepSeek models hosted by Mistral — billed on your plan's monthly quota, not
on pay-as-you-go API credits. The model list is discovered live from your
own account, so new models appear without an extension update.

[![OMP extension](https://img.shields.io/badge/OMP-extension-8A2BE2)](https://github.com/can1357/oh-my-pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Models: dynamic](https://img.shields.io/badge/models-dynamic-blue)](#models)

</div>

---

## Why this exists

OMP ships a built-in `mistral` provider, but it only takes a standard API key
created on the Mistral console. Keys obtained that way bill against API
credits or pay-as-you-go, **not** against the monthly usage included in a
Mistral Pro or Team subscription.

Mistral's own Vibe Code CLI solves this with a browser sign-in flow on
`console.mistral.ai` that provisions a key tied to your plan. This extension
implements the same flow for OMP, so a third-party agent can use your
subscription the same way the official CLI does.

> [!IMPORTANT]
> Usage through this provider is billed against the **Vibe Code quota of your
> Mistral plan**. Verified empirically: sustained traffic through this
> provider moves the "Vibe Code" usage counter of the plan, not the API
> credits counter. Verify on your own account in the Mistral admin panel if
> billing matters to you, and see [Billing](#billing) for details.

## Requirements

- [OMP](https://github.com/can1357/oh-my-pi) 18 or later
- A Mistral **Pro** or higher subscription with access to Mistral AI Studio

## Install

**From this repository (recommended):**

```sh
omp install https://github.com/Gauthier-Huguenin/omp-mistral-subscription
```

**Try it once without installing:**

```sh
omp -e https://github.com/Gauthier-Huguenin/omp-mistral-subscription \
    --model mistral-subscription/mistral-medium-2604
```

**Manual install:** copy `extensions/mistral-subscription/index.ts` into
`~/.omp/agent/extensions/mistral-subscription/index.ts`. OMP auto-discovers
it on startup.

## Use

Start OMP, then run `/login` and pick **Mistral subscription
(console.mistral.ai sign-in)**. Your browser opens a Mistral sign-in page;
approve it, and the credential is stored in OMP's auth store.

Then select a model:

```text
/model mistral-subscription/mistral-medium-2604
```

Switch models with `/model`, inspect the provider with
`/mistral-subscription-status`, and revoke access with `/logout` in the
session plus a key revocation on the Mistral console.

## Models

The model list is **discovered at runtime** from your account's own
`GET https://api.mistral.ai/v1/models` response, so it always matches what
your plan serves. Mistral lists each underlying model under several alias ids
sharing one `billing_model_name` (e.g. `mistral-medium-latest`,
`mistral-medium-3.5`, `mistral-vibe-cli-latest`); those rows are collapsed
to one canonical entry so the model picker stays clean.

As of 2026-11-04 a Pro account discovers 14 chat models:

| Model id | Context | Reasoning | Efforts | Images |
| --- | --- | --- | --- | --- |
| `codestral-2508` | 256k | no | - | no |
| `deepseek-v4-1-flash-1017` | 1M | yes | low, high, xhigh, max | no |
| `labs-leanstral-1-5` | 262k | yes | low, medium, high, xhigh | yes |
| `mistral-large-4` | 1M | yes | low, medium, high | yes |
| `mistral-large-2512` | 262k | no | - | yes |
| `mistral-medium-2604` | 262k | yes | low, medium, high, xhigh | yes |
| `mistral-small-2603` | 262k | yes | low, medium, high, xhigh | yes |
| `ministral-14b-2512` | 262k | no | - | yes |
| `ministral-8b-2512` | 262k | no | - | yes |
| `ministral-3b-2512` | 131k | no | - | yes |
| `voxtral-small-2507` | 33k | no | - | no |
| `zai-glm-5-3` | 1M | yes | low, high, max | no |
| `zai-glm-5-3-flash` | 1M | yes | low, high, max | yes |
| `zai-glm-5-2` | 1M | yes | low, medium, high, xhigh, max | no |

Notes:

- Context windows, vision, and reasoning flags come from the models response;
  OMP fills costs and max output tokens from its bundled catalog by model id
  (unknown ids get a notional zero cost). The subscription plan covers these
  calls, so no invoice matches the reported spend.
- Reasoning effort ranges are verified against the live API: Mistral's own
  models accept `reasoning_effort` values `none` and `high` only, so OMP's
  four levels are mapped onto that pair; hosted GLM, DeepSeek, and Large 4
  models expose their own ladders (`max` included) and pass through as-is.
- Mistral's chat API never accepts `reasoning_content` in assistant message
  history (HTTP 422 `extra_forbidden`) and emits thinking as content parts;
  the extension declares this wire compat on every discovered model, since
  OMP's bundled catalog pins the same behavior to the provider id `mistral`
  and does not match a custom provider id.
- Models your plan gates (e.g. Labs models disabled for your org) stay
  listed but return an error on use; Mistral's models endpoint does not
  surface entitlements.
- Labs models (`labs-*`) also require admin enablement in your organization
  settings.
- Refresh the list any time with `omp models refresh`.

## Billing

Mistral's plan accounting distinguishes the API surface (per-token, credits
or pay-as-you-go) from the Vibe surface (agent products, monthly quota). Both
share one spending cap, but the buckets differ.

This extension authenticates with the key minted by the Vibe browser sign-in,
and **empirically** its traffic is counted against the Vibe Code quota of the
plan, not against API credits:

- Sustained generation traffic (12 requests, 46k completion tokens, zero
  errors) moved the plan's **Vibe Code** usage counter, as observed in the
  Mistral admin panel.
- The same account's API credits counter did not move.

If your plan was purchased through a partner (Orange, Free Mobile, Google,
Apple), pay-as-you-go cannot be enabled, so usage stops at quota exhaustion.
Check your plan in the Mistral admin panel before relying on this for heavy
workloads.

## How it works

1. `/login` calls `POST https://console.mistral.ai/api/vibe/sign-in` with a
   PKCE S256 code challenge. No credentials are sent, your browser session
   does the authorizing.
2. OMP opens the returned
   `console.mistral.ai/codestral/cli/authenticate?process_id=...` page.
3. The extension polls the returned `poll_url` until the browser session
   approves, then exchanges `exchange_token` and `code_verifier` at
   `POST .../vibe/sign-in/{process_id}/exchange`, which returns the API key.
4. The key is stored in OMP's auth store and sent as
   `Authorization: Bearer` on requests to
   `https://api.mistral.ai/v1/chat/completions`.
5. OMP calls the extension's model discovery with the stored key, which lists
   `GET https://api.mistral.ai/v1/models` and caches the result for 24 h.
   `/login` and `omp models refresh` both force a fresh fetch.

This flow mirrors the Mistral Vibe Code CLI's own browser sign-in, ported
from [5omeOtherGuy/pi-mistral-subscription](https://github.com/5omeOtherGuy/pi-mistral-subscription)
for the Pi coding agent. This package contains no credentials, tokens, or
API keys, and never sees your Mistral password.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `model not found` for a model id | The plan gates model access. Pick another discovered model with `omp models mistral-subscription`. |
| Sign-in page opens but nothing happens | The sign-in process expired (10 min). Run `/login` again. |
| `HTTP 401` on requests | Key revoked or plan lapsed. `/logout`, then `/login` again. |
| `HTTP 429` | Rate limit. OMP retries automatically; for sustained heavy use, check your plan's limits. |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
for the ground rules, and [SECURITY.md](SECURITY.md) before reporting
anything security-related.

## License

[MIT](LICENSE)
