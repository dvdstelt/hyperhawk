# Troubleshooting

**The action posts no comments on my PR.**
Ensure the workflow has `pull-requests: write` permission and that the `token` input is set (it defaults to `GITHUB_TOKEN` which should work in most cases).

**External links are timing out.**
Increase the `timeout` input (value is in milliseconds). The default is `10000` (10 seconds). Some sites are slow to respond to HEAD requests; HyperHawk falls back to GET automatically whenever HEAD returns an error status, so a host that mishandles HEAD (for example `support.google.com`, which answers 404 to HEAD but serves the page on GET) is not reported as broken.

**A link is reported as broken but it works in my browser.**
Some sites block requests from CI runners or require cookies. Add the domain to `ignore-patterns` to skip it.

**Same-org links to private repos are reported as broken even though the repos exist.**
`GITHUB_TOKEN` cannot access private repositories outside the current repo. The error will say "not accessible with the provided token". Switch to a fine-grained PAT or GitHub App token as described in [Cross-repo access](/docs/cross-repo-access.md).

**I get rate-limit errors for same-org checks.**
Reduce `concurrency` or provide a token with higher rate limits via a personal access token stored in a secret:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.MY_PAT }}
```

**The action says a link is ambiguous and gives no suggestion.**
This means more than one file in the repo has the same filename. Rename one of them or update the link manually to include the full root-relative path.

**I resolved a HyperHawk comment but the link is still broken.**
Resolving a comment tells HyperHawk to stop re-posting it. The deduplication logic still sees the resolved comment, so it will not appear again on subsequent pushes. Fix the broken link directly, or re-open the resolved comment if you want to keep tracking it.

**I get warnings about broken links on lines I did not change.**
By default, HyperHawk reports broken links on all lines in changed files, even lines outside the diff. Set `report-only-changed: true` to suppress these warnings and only get feedback on lines you actually changed.

**Links inside code blocks are being checked.**
By default, HyperHawk extracts links from all lines, including fenced code blocks. Set `skip-code-blocks: true` to skip links inside `` ``` `` and `~~~` fences.
