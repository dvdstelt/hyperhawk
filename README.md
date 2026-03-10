<div align="center">
  <img src="media/hyperhawk-banner.png" alt="HyperHawk" width="500" />
  <p>A GitHub Action that scans your markdown files for broken links and reports them directly on pull requests as inline review comments, including one-click suggestions to fix them.</p>
</div>

---

## What it does

- Checks **internal links** (relative and root-relative paths) by verifying the file exists on disk
- Checks **same-org GitHub links** via the GitHub API
- Checks **external HTTP/HTTPS links** with configurable timeout and retry logic
- On **pull requests**: posts inline review comments with suggestion blocks you can apply in one click
- On **push / schedule**: writes a summary table and emits warning annotations
- Never fails the workflow unless you opt in to [strict mode](/docs/configuration.md#strict-mode)

---

## Quickstart

**.github/workflows/link-check.yml**

```yaml
name: Link Check

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

> **Versioning:** `@v1` always runs the latest `v1.x.x` release. For a fully pinned version use a tag like `@v1.2.1`.

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
| `ignore-patterns` | no | _(empty)_ | Comma-separated regex patterns. Matching URLs are skipped. |
| `timeout` | no | `10000` | Timeout in milliseconds for each external link request. |
| `concurrency` | no | `5` | Number of links checked in parallel. |
| `strict` | no | `false` | Fail the workflow when broken links are found. |

---

## Documentation

- [Configuration](/docs/configuration.md) - strict mode, ignore patterns, scanning scope
- [How it works](/docs/how-it-works.md) - link classification, PR review behaviour, permissions
- [Cross-repo access](/docs/cross-repo-access.md) - checking links into private repositories
- [Workflow examples](/docs/examples.md) - common workflow configurations
- [Troubleshooting](/docs/troubleshooting.md) - common issues and solutions
