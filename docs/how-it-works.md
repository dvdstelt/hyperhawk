# How it works

## Link classification

| URL pattern | Classified as | How it is checked |
|-------------|--------------|-------------------|
| No scheme, starts with `.`, `/`, or `#` | Internal | File existence on disk |
| `https://github.com/<same-owner>/...` | Same-org | GitHub REST API |
| Everything else | External | HTTP HEAD request, falling back to GET if HEAD returns 405 |

Each unique URL is checked only once per run, regardless of how many files reference it.

Links that are not verifiable (such as `mailto:` links and URLs with invalid hostnames) are silently skipped.

## PR review behaviour

HyperHawk posts a single `COMMENT`-type review (never `REQUEST_CHANGES`) so it never blocks merging. Each broken link becomes an inline comment on the affected line. When multiple broken links appear on the same line, they are consolidated into a single comment with one merged suggestion.

When a fix can be determined automatically, the comment includes a GitHub suggestion block you can apply directly from the PR interface with a single click.

### Broken link suggestions

When a broken internal link can be located elsewhere in the repo, HyperHawk suggests the correct path automatically. If the file was moved to a different folder but kept the same name, the fix is a one-click apply.

### Root-relative path suggestions

Working links that use relative paths (`../../docs/guide.md`) get a suggestion to convert them to root-relative paths (`/docs/guide.md`). Root-relative links never break when the file containing them is moved.

### Self-repo URL suggestions

Full GitHub URLs that point back to the current repository (e.g. `https://github.com/owner/repo/blob/main/README.md`) get a suggestion to rewrite them as local paths. This avoids unnecessary network requests and keeps links working across forks.

## Permissions

The minimum permissions required are:

```yaml
permissions:
  contents: read
  pull-requests: write
```

`pull-requests: write` is only needed when the workflow runs on `pull_request` events. For push-only or schedule-only setups, `contents: read` is sufficient.
