# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-22

The first release. It ships the whole guideme 0.2.0 contract, as published by
[guideme-rust](https://github.com/pedro-pscunha/guideme-rust) at
`1565ce95015196e8f49bbc18dcb4b4b0cf429aed`.

### Added

- `Guide`, `Guide.fromEnv`, `ask` over a question, an `as const` tuple, an array or an object,
  `askWithReceipt`, `models`, and `withPolicy`.
- The five question constructors — `noul`, `choose`, `score`, `chooseAmong`, `scoreLevels` —
  and the `choice` / `levels` descriptors, whose key unions make a missing `switch` case a
  compile error.
- Examples and counterexamples on options and on noul criteria, examples on levels, through
  `option`, `level` and `fallback`, rendered byte-identically to every other guideme SDK.
- The unsure ladder: a question's `.or(..)`, then the descriptor's `fallback`, then a typed
  `unsure` error. `.detail()` never fails.
- The receipt: the versioned model that answered and the tokens the call cost.
- The 0.2.0 retry policy on both `POST /v1/systemone` and `GET /v1/models`.
- `fetch` injection, so a caller's code is testable with no server.
- OpenTelemetry spans and events under the names in `docs/observability.md`.
- `@opentelemetry/api` as a required peer dependency, `^1.9.0`, and `zod` as `^4.6.5`. npm
  refuses the install (`ERESOLVE`) when the application's API does not satisfy `^1.9.0`; bun
  and pnpm warn, then use the application's copy.
- Type exports for every type a caller writes in a signature: `ChoiceDescriptor`,
  `LevelsDescriptor`, `DetailedNoulQuestion`, `DetailedChoiceQuestion`,
  `DetailedScoreQuestion`, `GuidemeErrorOptions`, `Shape`, `Answered`, `Instructions`,
  `OptionParts` and `LevelParts`, so a caller never has to spell `ReturnType<..>` or
  `Parameters<..>`. A question type's answer parameter is structural, so a `.detail()` or a
  question of one key set never passes for another's, and a question cannot be written as an
  object literal.
