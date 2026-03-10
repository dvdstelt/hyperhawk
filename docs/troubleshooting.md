# Troubleshooting

**The action posts no comments on my PR.**
Ensure the workflow has `pull-requests: write` permission and that the `token` input is set (it defaults to `GITHUB_TOKEN` which should work in most cases).

**External links are timing out.**
Increase the `timeout` input (value is in milliseconds). The default is `10000` (10 seconds). Some sites are slow to respond to HEAD requests; HyperHawk falls back to GET automatically when HEAD returns 405.

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
