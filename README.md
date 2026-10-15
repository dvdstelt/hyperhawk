<div align="center">
  <img src="/media/hyperhawk-banner.png" alt="HyperHawk" width="500" />
  <p>A GitHub Action that scans your markdown files for broken links and reports them directly on pull requests as inline review comments, including one-click suggestions to fix them.</p>
</div>

---

## What it does

- Checks **internal links** (relative and root-relative paths) by verifying the file exists on disk
- Checks **same-org GitHub links** via the GitHub API, including file existence and blob/tree correctness
- Checks **external HTTP/HTTPS links** with redirect following, timeout, and bot-detection avoidance
- **Suggests fixes**: corrected paths for moved files (closest match on folder, file name and anchor), root-relative conversions, updated redirect targets, branch name updates, and blob/tree corrections
- On **pull requests**: posts inline review comments with suggestion blocks you can apply in one click
- On **push / schedule**: writes a summary table and emits warning annotations
- Never fails the workflow unless you opt in to [strict mode](/docs/configuration.md#strict-mode)

---

## Documentation

- [Configuration](/docs/configuration.md) - strict mode, ignore patterns, scanning scope
- [How it works](/docs/how-it-works.md) - link classification, PR review behaviour, permissions
- [Cross-repo access](/docs/cross-repo-access.md) - checking links into private repositories
- [Workflow examples](/docs/examples.md) - common workflow configurations
- [Troubleshooting](/docs/troubleshooting.md) - common issues and solutions

---

## Quickstart

**.github/workflows/link-check.yml**

```yaml
name: Hyperhawk

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * 1'   # every Monday at midnight

jobs:
  link-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - uses: dvdstelt/hyperhawk@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

> [!NOTE]
>
> **Versioning:**
>
> `@v1` always runs the latest `v1.x.x` release. For a fully pinned version use a tag like `@v1.2.1`.
>
> You can also use `@main` to always run the very latest code. Since HyperHawk only reads your links and never modifies your repository, the worst a bad commit can do is report a false positive or miss a broken link.

Need to check links into **private repositories** in the same org? See [Cross-repo access](/docs/cross-repo-access.md).

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | yes | `${{ github.token }}` | GitHub token for PR comments and reading the diff. `GITHUB_TOKEN` is sufficient. |
| `cross-repo-token` | no | _(empty)_ | Separate token for same-org link checks. See [cross-repo access](/docs/cross-repo-access.md). |
| `files` | no | `**/*.md,**/*.mdx` | Comma-separated glob patterns for files to scan. |
| `check-external` | no | `true` | Whether to check external HTTP/HTTPS links. |
| `check-same-org` | no | `true` | Whether to verify same-org GitHub links via the API. |
| `check-relative` | no | `true` | Whether to check relative file links (`../x.md`, `./x.md`, `folder/x.md`). Root-relative (`/x.md`) links are always checked. |
| `check-anchors` | no | `true` | Verify that the heading in a link anchor exists (`guide.md#section`, `#section`). Line anchors (`#L10`) are not verified. A missing heading never fails the workflow. |
| `relative-suggestion-depth` | no | `0` | Skip root-relative conversion suggestions for relative links within this many directory levels (`0` = only same-folder; `1` also exempts `../x.md` and `folder/x.md`). Max `5`; disable `check-relative` for deeper. |
| `ignore-patterns` | no | _(empty)_ | Comma-separated regex patterns. Matching URLs are skipped. |
| `timeout` | no | `10000` | Timeout in milliseconds for each external link request. |
| `concurrency` | no | `5` | Number of links checked in parallel. |
| `strict` | no | `false` | Fail the workflow when broken links are found. |
