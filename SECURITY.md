# Security policy

## Supported versions

`@guideme/sdk` is at 0.2.0, which is the only release and therefore the only supported
version. A published version on npm is effectively permanent — unpublishing is allowed only
in a narrow window and never for a version others depend on — so a fix ships as a new version
and the affected one is deprecated.

## Reporting a vulnerability

Report it privately, not in a public issue. GitHub private vulnerability reporting is enabled
on this repository:
[open an advisory](https://github.com/pedro-pscunha/guideme-typescript/security/advisories/new),
or go to the Security tab and choose **Report a vulnerability**. Only the maintainers can see
it.

This is a small project with nobody on call, so there is no response time to promise. You
will get an answer; it may not be the same day.

## Scope

In scope, because this package owns them:

- **The API key.** `ApiKey` holds it in a `#private` field that no reflection reaches, and
  every way JavaScript turns a value into text yields `ApiKey(***)`: `toString`,
  `Symbol.toPrimitive`, `toJSON`, and the `util.inspect` hook that `console.log` uses.
  `test/redaction.test.ts` proves all of them, proves the key is on no span attribute and in
  no span event, and walks a thrown error's whole `cause` chain and stacks for it and for the
  `Bearer` header value. Any path that puts the key somewhere a caller can read it is a
  vulnerability.
- **State confidentiality.** The state passed to `Guide.ask` is user data. Its content never
  reaches a span unless `recordState: true` was set; its length in bytes,
  `guideme.state.bytes`, always does. Recording the content without that opt-in is a defect
  here. So is putting a `422` response body on a span: that body can echo the state, so it
  stays on the returned error, and `test/tracing.test.ts` asserts it.
- **The wire layer** under `src/api/`: request construction, transport, status and error
  handling, the retry path, and any response the service could return that makes the decoder
  behave incorrectly. Redirects are deliberately not followed, because the `Authorization`
  header would travel with one; `docs/design.md` records why.
- Vulnerable dependencies reachable from library code. `mise run audit` scans the lock file
  on every gate and weekly in CI.

Out of scope:

- **The TypeSafe service itself.** Its behaviour, its models, its authentication and its
  handling of the data you send are upstream, not here: see <https://docs.typesafe.ai>. This
  package is a client.
- What a model decides. A judgment you disagree with is not a vulnerability.
- `examples/`, which is illustrative and builds outside the package.
- A key you leaked yourself, by printing it or committing a `.env`.
