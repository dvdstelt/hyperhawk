# How it works

## Link classification

| URL pattern | Classified as | How it is checked |
|-------------|--------------|-------------------|
| No scheme, starts with `.`, `/`, or `#` | Internal | File existence on disk |
| `https://github.com/<same-owner>/...` | Same-org | GitHub REST API |
| `https://github.com/user-attachments/assets/...` | External | Skipped (always valid) |
| Everything else | External | HTTP HEAD request, falling back to GET if HEAD returns any 4xx or 5xx |

Each unique URL is checked only once per run, regardless of how many files reference it.

Links that are not verifiable (such as `mailto:` links and URLs with invalid hostnames) are silently skipped.

Internal links split into two kinds: **relative** (`../x.md`, `./x.md`, `folder/x.md`) and **root-relative** (`/x.md`). External and same-org checks can be turned off with `check-external` and `check-same-org`; relative checks can be turned off with `check-relative` (root-relative links are always checked). See [Relative link checking](/docs/configuration.md#relative-link-checking).

### URL parsing

HyperHawk supports one level of balanced parentheses inside markdown link URLs, so links like `[topic](https://en.wikipedia.org/wiki/Topic_(DJ))` are extracted correctly.

Percent-encoded characters in internal link paths (e.g. `%20` for spaces) are decoded before checking the filesystem.

When `skip-code-blocks` is enabled, content inside fenced code blocks (`` ``` `` or `~~~`) is excluded from link extraction.

### External link handling

External links are checked with browser-like headers to avoid bot-detection blocks. The following responses are treated as valid rather than broken:

- **401 / 403** (auth-wall or bot-blocked): the URL exists but requires authentication
- **429** (rate-limited): the URL exists but is throttling automated access

When an external link redirects, HyperHawk follows the redirect chain and suggests updating to the final destination URL, but only when the redirect stays on the same hostname. Cross-domain redirects (typically auth/login flows) are not suggested as corrections.

Tracking parameters that the redirect adds (`visit_id`, `rd`, `utm_*`, ad click ids, and similar) are stripped from the suggestion, because they identify the visit rather than the content and go stale as soon as they are committed. A parameter that was already on your link is kept. If stripping leaves the destination identical to the original link, no suggestion is made at all.

### GitHub user-attachment assets

URLs matching `https://github.com/user-attachments/assets/...` are treated as always valid without making an HTTP request. These are image and file uploads attached to issues, PRs, and discussions. They cannot be deleted without GitHub admin intervention and are effectively permanent, so verifying them would add complexity for no benefit.

### Same-org link checks

Same-org links are verified through the GitHub REST API:

- **Repository existence** is verified via an authenticated API call. If the repo returns 404, HyperHawk makes an unauthenticated request to distinguish private repos (silently skipped) from truly non-existent ones (reported as broken).
- **File/directory existence** is verified via the `getContent` API when the URL includes a path (e.g. `/blob/main/docs/guide.md`).
- **Default branch detection**: when a file is not found at the ref specified in the URL (e.g. `master`) but exists on the repo's current default branch (e.g. `main`), HyperHawk suggests updating the branch name.
- **Blob/tree mismatch**: GitHub uses `/blob/` for files and `/tree/` for directories. When a cross-repo link uses the wrong prefix, HyperHawk suggests correcting it.
- **Org-level URLs** (e.g. `/orgs/owner/projects/123`) are trusted without further verification.

### Deduplication

HyperHawk tracks which comments it has already posted using hidden HTML markers in the comment body, keyed on file path and URL. If a link shifts to a different line number between pushes (e.g. because lines were added above it), the existing comment is still recognised and a duplicate is not posted.

Resolving a HyperHawk comment is permanent for that PR: the resolved comment is still tracked by the deduplication logic, so HyperHawk will not re-post it on subsequent pushes. If the underlying link is still broken, fix it or re-open the resolved comment manually.

## PR review behaviour

HyperHawk posts a single `COMMENT`-type review (never `REQUEST_CHANGES`) so it never blocks merging. Each broken link becomes an inline comment on the affected line. When multiple broken links appear on the same line, they are consolidated into a single comment with one merged suggestion.

When a fix can be determined automatically, the comment includes a GitHub suggestion block you can apply directly from the PR interface with a single click.

### Broken link suggestions

When a broken internal link can be located elsewhere in the repo, HyperHawk suggests the correct path automatically.

At the start of a run, HyperHawk builds a list of every URL the repository exposes: each file, and each markdown file with each of its headings. The broken link is matched against that list. Each candidate gets a score from three parts:

1. **Folder.** The folder of the link and the folder of the candidate are compared segment by segment. A renamed segment (`Brand style guide` to `brand-style-guide`) costs little, a different segment (`rabbitmq` to `kafka`) costs almost a full segment, a missing parent folder costs half a segment. This part weighs most.
2. **File name.** Similarity of the file names without extension. Only files with the same extension and a similar name are candidates.
3. **Anchor.** Similarity of the heading in the link and the heading of the candidate. A file without that heading is still a candidate with a neutral anchor score, so a moved file whose heading was renamed is still found; the suggestion then has no anchor. Line anchors (`#L10`) address lines, not headings, and are kept as they are.

Among candidates whose folders fit equally well, the one nearest to the source file wins. That selects the file in the same folder when the link has one `../` too many. When the best candidate still ties, no fix is suggested and the report lists the candidates.

A suggestion is only made when the score is high enough, or when the file name exists exactly once in the repository (a moved file). Links into another repository therefore get no one-click fix. Every suggestion is a closest match, not a certainty, and the comment says so.

### Anchor checking

A link to a markdown file that exists, but with an anchor that has no matching heading (`guide.md#missing-section`, or `#missing-section` in the same file), is reported as a broken link. When the file has a similar heading, HyperHawk suggests it as the closest match. This kind of broken link does not fail the workflow in [strict mode](/docs/configuration.md#strict-mode). The check can be turned off with [`check-anchors: false`](/docs/configuration.md#anchor-checking).

### Root-relative path suggestions

Working links that use relative paths (`../../docs/guide.md`) get a suggestion to convert them to root-relative paths (`/docs/guide.md`). Root-relative links never break when the file containing them is moved. Same-folder links (e.g. `readme.md` or `./readme.md`) are left as-is since they are simple and unlikely to break.

How close counts as "leave it alone" is configurable via [`relative-suggestion-depth`](/docs/configuration.md#tuning-conversion-suggestion-depth): links that traverse no more than the configured number of directory levels are exempt from this suggestion. Relative-link checking can also be turned off entirely with `check-relative: false`. Neither setting affects broken-link detection: a relative link to a missing file is always reported.

### Self-repo URL suggestions

Full GitHub URLs that point back to the current repository (e.g. `https://github.com/owner/repo/blob/main/README.md`) get a suggestion to rewrite them as local paths. This avoids unnecessary network requests and keeps links working across forks. When the target file has been moved, the same fuzzy-matching logic is used to suggest the corrected local path.

### Redirect suggestions

External links that redirect to a different URL on the same host get a suggestion to update to the final destination, with any tracking parameters the redirect added stripped out. Fragment identifiers (`#section`) from the original URL are preserved when the redirect target does not include one.

## Permissions

The minimum permissions required are:

```yaml
permissions:
  contents: read
  pull-requests: write
```

`pull-requests: write` is only needed when the workflow runs on `pull_request` events. For push-only or schedule-only setups, `contents: read` is sufficient.
