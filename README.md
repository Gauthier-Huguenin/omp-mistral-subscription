<div align="center">

# omp-mistral-subscription

**Use your Mistral Vibe subscription in [OMP](https://github.com/can1357/oh-my-pi).**

Browser sign-in on `console.mistral.ai`, then code with Mistral Medium 3.5,
Devstral 2, or Z.ai GLM 5.3, billed on your plan's monthly quota, not on
pay-as-you-go API credits.

[![OMP extension](https://img.shields.io/badge/OMP-extension-8A2BE2)](https://github.com/can1357/oh-my-pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Models: 8](https://img.shields.io/badge/models-8-blue)](#models)

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

| Model id | Name | Context | Reasoning | Images | $/M in, out |
| --- | --- | --- | --- | --- | --- |
| `mistral-medium-2604` | Mistral Medium 3.5 | 262k | yes | yes | 1.50, 7.50 |
| `mistral-small-latest` | Mistral Small 4 | 256k | yes | yes | 0.15, 0.60 |
| `mistral-large-latest` | Mistral Large 3 | 262k | no | yes | 0.50, 1.50 |
| `devstral-medium-latest` | Devstral 2 | 262k | no | no | 0.40, 2.00 |
| `ministral-14b-2512` | Ministral 3 14B | 262k | no | yes | 0.20, 0.20 |
| `ministral-8b-2512` | Ministral 3 8B | 131k | no | yes | 0.15, 0.15 |
| `ministral-3b-2512` | Ministral 3 3B | 131k | no | yes | 0.10, 0.10 |
| `zai-glm-5-3` | Z.ai GLM 5.3 (hosted by Mistral) | 1M | yes | no | 1.40, 4.40 |

Model ids and limits were read from the account's own
`GET https://api.mistral.ai/v1/models` response and cross-checked against
Mistral's models overview and pricing pages.

Notes:

- Costs are Mistral's public list prices, reported as a **notional** spend.
  The subscription plan covers these calls, so no invoice matches the figure.
- `zai-glm-5-2` is intentionally absent: Mistral deprecated it on 2026-09-29
  and removes it on 2026-10-31, replaced by GLM 5.3.
- No thinking surface is declared for `zai-glm-5-3`: Mistral documents no
  `reasoning_effort` control for it. The parameter is accepted by the API
  but its effect is unverified.

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

This flow mirrors the Mistral Vibe Code CLI's own browser sign-in, ported
from [5omeOtherGuy/pi-mistral-subscription](https://github.com/5omeOtherGuy/pi-mistral-subscription)
for the Pi coding agent. This package contains no credentials, tokens, or
API keys, and never sees your Mistral password.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `Unknown OAuth provider 'mistral-subscription'` | Extension not loaded. Reinstall, or check `omp models` lists `mistral-subscription/*` models. |
| Sign-in page opens but nothing happens | The sign-in process expired (10 min). Run `/login` again. |
| `HTTP 401` on requests | Key revoked or plan lapsed. `/logout`, then `/login` again. |
| `HTTP 429` | Rate limit. OMP retries automatically; for sustained heavy use, check your plan's limits. |
| `model not found` for a model id | The plan gates model access. Fall back to `mistral-medium-2604`. |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
for the ground rules, and [SECURITY.md](SECURITY.md) before reporting
anything security-related.

## License

[MIT](LICENSE)
