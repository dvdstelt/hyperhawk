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
tests/
  snapshot.ts            <- snapshot test runner; its output is compared with expected-output.txt
  expected-output.txt    <- expected output of snapshot.ts
  test-document.md       <- markdown fixture with the links under test
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

## Testing

Run the type check and the snapshot test before you commit:

```bash
npm run typecheck
npm run test:snapshot
```

`test:snapshot` runs `tests/snapshot.ts` and compares its output with `tests/expected-output.txt`. If you change the output on purpose, update `tests/expected-output.txt` in the same commit.

### Bug fixes

1. Write a test that reproduces the bug.
2. Run the test on the unchanged code. Make sure that it fails for the reason in the bug report.
3. Fix the code.
4. Run the full snapshot test again.

The test must go through `checkLinks`, so that it fails if someone reverts the fix. A test for a new helper function alone does not prove the fix.

### Test same-org checks with a stub Octokit

Same-org checks (`checkSameOrg`) use the GitHub API. Do not call the real API in tests. `checkLinks` gets the Octokit client as a parameter. Give it a stub that implements `rest.repos.get` and `rest.repos.getContent`:

```ts
const calls: string[] = [];
const octokit = { rest: { repos: {
  get: async () => ({ data: { default_branch: 'main', private: false } }),
  getContent: async ({ ref, path }: { ref: string; path: string }) => {
    calls.push(`${ref}|${path}`);
    if (ref !== 'main') throw Object.assign(new Error(`No commit found for the ref ${ref}`), { status: 404 });
    if (path === 'docs/guide.md') return { data: { type: 'file' } };
    throw Object.assign(new Error('Not Found'), { status: 404 });
  },
}}} as any;
```

For a directory, return `{ data: [] }`. Rules for the stub:

- Use a different URL for each test case. `resultCache` keeps the result of each URL for the full run.
- Make `repos.get` succeed. A 404 from `repos.get` starts `looksPrivate`, which sends a real request to GitHub.
- Use a repository name that is different from `config.repo`. Links to the current repository go to `suggestLocalPath` and do not use the API.
- Give each error a `status` property, as in the example.
- Use the 404 messages of the GitHub API: `No commit found for the ref <ref>` for a missing ref, and `Not Found` for a missing path.
- Write the list of API calls into the test output. Then the snapshot also catches changes to the order and the number of calls.

Test the error paths too, not only the success path. Include a 404, a 403 (rate limit), and a 500.

### API calls and the rate limit

Same-org checks share the GitHub API rate limit. For example, a `GITHUB_TOKEN` gets 1,000 requests per hour for each repository. When the limit is reached, all other same-org links show as API errors.

- Do not add API calls for valid links.
- If a change adds API calls for other links, give the number of calls before and after in the PR description.

### Pull request descriptions

Check each claim in the PR description with a test or with a command that you ran. For example, if the description says that valid links get no extra API calls, count the calls in a test.

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
