# Contributing to omp-mistral-subscription

Thanks for considering a contribution. This project is deliberately small:
one extension file, one provider, one sign-in flow. Keep it that way.

## Ground rules

- **Small and light wins.** No build step, no bundler, no transitive
  dependencies. The whole package is one TypeScript file loaded directly by
  OMP's extension runtime, plus metadata. A change that adds a dependency or
  a build step needs a very good reason.
- **Empiricism over assumptions.** Claims about model ids, prices, context
  windows, or billing behavior must be verifiable: read them from
  `GET https://api.mistral.ai/v1/models`, Mistral's docs and pricing pages,
  or the admin panel. State where a number came from in the PR.
- **No credentials, ever.** Never commit keys, tokens, screenshots of
  consoles, or URLs containing `complete_token` or `process_id`. The
  repository must stay credential-free.

## What fits here

- New models served by the Mistral platform (add the id, verified limits,
  and the public list price).
- Fixes to the sign-in flow when Mistral changes it (the flow mirrors the
  Vibe Code CLI, see `vibe/core/config` in
  [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe)).
- Documentation corrections, better error messages, compatibility fixes for
  new OMP versions.

## What does not fit

- Turning this into a general Mistral SDK, proxy, or gateway.
- Adding usage/quota reporting. That requires a Mistral usage API this
  extension does not target; if you want it, open an issue first with a
  link to the documented endpoint.
- Support for other providers. One repo, one provider.

## Workflow

1. Open an issue first for anything non-trivial, describing the observed
   behavior and how you verified it.
2. Fork, branch, commit with a clear message.
3. Keep the diff minimal. `npx prettier` or your editor's formatter is fine;
  reformatting the whole file is not.
4. Open a pull request against `main` with what changed and how you tested
   it. Manual testing with a real Mistral subscription is the only test
   environment that matters here.

## Reporting issues

Include:

- OMP version (`omp --version`)
- The exact error text
- What you expected and what happened
- Your Mistral plan tier (Pro, Team, partner-billed...) if billing or model
  access is involved

Do **not** include API keys, sign-in URLs, or token fragments.
