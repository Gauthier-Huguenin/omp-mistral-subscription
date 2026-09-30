# Security policy

## Credentials

This extension stores the API key it obtains in OMP's own credential store
(`~/.omp/agent/agent.db`). The repository contains no credentials, and the
sign-in flow never sees your Mistral password: the browser session handles
authentication directly with Mistral.

## Reporting a vulnerability

If you find a security issue in this extension, please report it privately
by opening a [GitHub security advisory](https://github.com/Gauthier-Huguenin/omp-mistral-subscription/security/advisories/new)
on this repository. Do not open a public issue with exploitation details.

Include what you found, how it could be abused, and, if possible, a minimal
reproduction. You will get a response; fixes ship as patch releases.

## Scope

- The sign-in flow and credential handling in
  `extensions/mistral-subscription/index.ts` are in scope.
- Mistral's own platform, console, or API behavior is out of scope: report
  those to Mistral.
- The OMP extension runtime is out of scope: report those upstream to
  [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
