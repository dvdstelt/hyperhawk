# Workflow examples

## Minimal setup

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
```

## Skip external link checking (air-gapped / restricted runners)

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    check-external: false
```

## Scan only a specific folder

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    files: 'docs/**/*.md'
```

## High-concurrency scan for large repos

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    concurrency: 20
    timeout: 15000
```

## Ignore specific domains and enable strict mode

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    ignore-patterns: 'localhost,example\.com'
    strict: true
```

## Cross-repo access with a GitHub App

See [Cross-repo access](/docs/cross-repo-access.md) for full setup instructions.

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ secrets.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}

- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    cross-repo-token: ${{ steps.app-token.outputs.token }}
```
