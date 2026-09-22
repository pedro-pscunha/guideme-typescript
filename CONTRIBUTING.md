# Contributing

guideme makes a TypeSafe Jev judgment usable as TypeScript control flow. It is one published
package, `@guideme/sdk`, with one entry point: `src/index.ts`.

Issues and pull requests are welcome. The one exception is a vulnerability, which goes
through [`SECURITY.md`](SECURITY.md) and never through a public issue. The package is on npm,
so the public surface is an API other people depend on; read the rules before changing it.

## The rules live in AGENTS.md

[`AGENTS.md`](AGENTS.md) is the contributor guide and it is binding. It says which file owns
which seam, the invariants that hold everywhere in `src/` and `test/`, the policy semantics
shared with every other guideme SDK, what a new test is allowed to be and how many there may
be, the commands, and the git and release process. Read it fully before editing.

Three sections carry most of what a first change needs:

- `## Commands` — the gate and the other tasks.
- `## Git` — branching, hooks, commit messages.
- `## Changing the contract` — what to do when a change reaches the wire, the policy or a
  telemetry field name. Those are contract changes and they have a checklist.

One rule surprises people, so it is worth naming here: **the test budget is a ceiling, not a
target.** There are forty vitest cases and `AGENTS.md` lists every one with the reason it
exists. A new case has to earn its place against that list, usually by replacing a row rather
than adding one.

## The loop

Tooling is managed by [mise](https://mise.jdx.dev); Node, Bun and gitleaks are pinned in
`mise.toml`.

```sh
mise install      # fetch the tools
bun install       # fetch the dependencies, from the committed bun.lock
mise run hooks    # activate the tracked git hooks, once per clone
mise run test     # while you work
mise run check    # the full gate; the pre-push hook runs it too
```

## License

Contributions are dual-licensed under [MIT](LICENSE-MIT) or
[Apache-2.0](LICENSE-APACHE), at your option, the same terms as the package. Unless you say
otherwise, anything you submit for inclusion is licensed that way, with no additional terms.
