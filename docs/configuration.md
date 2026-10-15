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

Go to **Settings > Secrets and variables > Actions** and create a secret named `LINK_CHECK_STRICT` with the value `true`. Then pass it in the workflow:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    strict: ${{ secrets.LINK_CHECK_STRICT }}
```

This way you can enable strict mode for specific repositories without changing the workflow file. Repositories without the secret continue to run in non-strict mode.

Strict mode fails on links to files that do not exist. A link to a file that exists but has no heading for the anchor (see [Anchor checking](#anchor-checking)) is reported as broken, but it does not fail the workflow.

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

## Relative link checking

HyperHawk checks relative file links (`../guide.md`, `./guide.md`, `folder/guide.md`) by resolving them against the file they appear in. Two inputs control this behaviour.

### Disabling relative links entirely

Set `check-relative: false` to skip relative links completely. They are neither validated for broken targets nor offered root-relative conversion suggestions. Root-relative links (`/docs/guide.md`) and anchors (`#section`) are still checked.

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    check-relative: false
```

### Tuning conversion-suggestion depth

Working relative links get a suggestion to convert them to root-relative paths (see [How it works](/docs/how-it-works.md#root-relative-path-suggestions)). Links that stay close to the current file often "belong together" and moving them in tandem is unlikely to break the link, so a suggestion is just noise.

`relative-suggestion-depth` sets how many directory levels a link may traverse before a suggestion is offered. A link's depth counts each `..` (up) or named directory (down) segment, ignoring the filename:

| Link | Depth |
|------|-------|
| `readme.md`, `./readme.md` | 0 (same folder) |
| `../readme.md`, `folder/readme.md` | 1 |
| `../../readme.md`, `../folder/readme.md` | 2 |

Links at or below the configured depth are left as-is; deeper links still get a suggestion. The default `0` exempts only same-folder links (the original behaviour). For example, `relative-suggestion-depth: 1` also leaves `../readme.md` and `folder/readme.md` alone:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    relative-suggestion-depth: 1
```

This only suppresses the conversion suggestion; genuinely broken relative links are still reported regardless of depth. The maximum is `5`. If you want to suppress suggestions for links deeper than that, disable relative checking with `check-relative: false` instead.

## Anchor checking

By default, HyperHawk verifies that the heading in a link anchor exists: `guide.md#section`, `#section` in the same file, and same-repository GitHub URLs with an anchor. A missing heading is reported as a broken link. When the file has a similar heading, the comment suggests it. Line anchors (`#L10`, `#L10-L20`) and anchors on files that are not markdown are not verified. A missing heading never fails the workflow, also in strict mode.

Set `check-anchors: false` to skip anchor verification:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    check-anchors: false
```

## Skip code blocks

By default, links inside fenced code blocks are checked like any other link. If your code blocks contain example URLs or configuration snippets that should not be validated, enable `skip-code-blocks`:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    skip-code-blocks: true
```

When enabled, any content between `` ``` `` or `~~~` fences is skipped during link extraction.

## Report only changed lines

By default, broken links found on unchanged lines in a PR produce check warning annotations. To suppress these and only report issues on lines you actually changed, enable `report-only-changed`:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    report-only-changed: true
```

This is useful for incremental adoption: you get feedback only on lines in the diff, without noise from pre-existing broken links elsewhere in the file.
