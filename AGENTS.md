# HyperHawk - Agent Instructions

This file contains instructions for AI coding agents working in this repository.

## Project overview

HyperHawk is a GitHub Action that scans markdown files for broken links. All TypeScript source lives in `src/`. The compiled bundle at `dist/index.js` is what GitHub's runner executes - it must always be committed and kept in sync with the source.

## Repository structure

```
action.yml               <- action metadata (inputs, runtime); must stay at repo root
src/
  index.ts               <- entry point; loads config, orchestrates the run
  types.ts               <- shared interfaces (LinkInfo, CheckResult, Config)
  extract.ts             <- link extraction from markdown files
  check.ts               <- link verification (internal / same-org / external)
  report.ts              <- PR review comments and step summary reporting
dist/
  index.js               <- ncc-bundled output; committed and kept in sync with src/
.github/
  workflows/
    ci.yml               <- typechecks, builds, and auto-commits dist/ on push
    link-check.yml       <- example consumer workflow
```

## After making source changes

Always rebuild before committing:

```bash
npm run build
```

The CI workflow (`ci.yml`) will rebuild and auto-commit `dist/` if you forget, but the action is unusable until that CI run completes. Build locally to keep the repo in a usable state at all times.

## Versioning and tagging

This project follows Semantic Versioning (SemVer). The versioning scheme uses:

- **Patch** (`v1.0.1`): bug fixes, no behaviour changes
- **Minor** (`v1.1.0`): new inputs or features, fully backwards compatible
- **Major** (`v2.0.0`): breaking changes - removed inputs, changed defaults, or behaviour that could cause previously passing workflows to fail

### Releasing a new version

1. Update `package.json` version field to match the new version
2. Rebuild: `npm run build`
3. Commit everything: `git commit -m "chore: release vX.Y.Z"`
4. Create an immutable tag for the exact version:
   ```bash
   git tag vX.Y.Z
   ```
5. Move the floating major version tag forward:
   ```bash
   git tag -f vX
   ```
6. Push commits and both tags:
   ```bash
   git push origin main
   git push origin vX.Y.Z
   git push origin vX --force
   ```

The `--force` flag is required when moving the floating tag because you are updating an existing tag to point at a new commit.

### Why two tags

Consumers pin to the floating major tag (`@v1`, `@v2`) so they receive patch and minor updates automatically without changing their workflow files. The immutable tag (`v1.2.3`) exists for consumers who want to pin to an exact version for auditability or reproducibility.

### Breaking changes and major versions

Before bumping the major version, consider whether the change can be made backwards compatible instead (e.g. adding a new input with a default that preserves the old behaviour). A major version bump requires every consumer to update their workflow file, which creates friction. Only do it when there is no reasonable backwards-compatible alternative.

When releasing a new major version, keep the previous floating tag pointing at its last stable commit. Consumers on `@v1` should continue to work indefinitely.

### Do not push tags automatically

Never push tags in CI or as part of an automated process. Tag creation is a deliberate release decision that must be made by a person.
