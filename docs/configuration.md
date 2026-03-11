# Configuration

## Strict mode

By default HyperHawk **never fails the workflow**. It reports problems as comments and annotations but always exits with a success code. This lets teams adopt it incrementally without blocking CI.

To fail the workflow on broken links, enable strict mode in one of two ways:

**Per-workflow input:**

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    strict: true
```

**Repository secret (recommended for gradual rollout):**

[Testlink](https://github.com/dvdstelt/hyperhawk/blob/main/docs/newfile.md)

Go to **Settings > Secrets and variables > Actions** and create a secret named `LINK_CHECK_STRICT` with the value `true`. Then pass it in the workflow:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    strict: ${{ secrets.LINK_CHECK_STRICT }}
```

This way you can enable strict mode for specific repositories without changing the workflow file. Repositories without the secret continue to run in non-strict mode.

## Ignore patterns

The `ignore-patterns` input accepts a comma-separated list of JavaScript regular expressions. Any link URL that matches at least one pattern is skipped.

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    ignore-patterns: 'localhost,example\.com,^https://internal\.'
```

Common use cases:

- Skip placeholder URLs: `example\.com`
- Skip links that require authentication: `^https://internal-wiki\.`
- Skip localhost references: `localhost`
- Skip a known flaky external site while keeping everything else: `flaky-site\.io`

## Scanning scope

| Trigger | Files scanned |
|---------|--------------|
| `pull_request` | Only `.md` and `.mdx` files changed by the PR |
| `push` | All `.md` and `.mdx` files in the repository |
| `schedule` | All `.md` and `.mdx` files in the repository |

On pull requests, only changed files are scanned. Broken links in files that are not part of the diff are reported as check annotations rather than inline comments.

The following directories are always excluded from scanning: `node_modules/`, `.git/`, `dist/`, `lib/`.


