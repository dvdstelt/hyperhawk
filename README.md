<div align="center">
  <img src="media/icon.png" alt="HyperHawk" width="96" />
  <h1>HyperHawk</h1>
  <p>A GitHub Action that scans your markdown files for broken links and reports them directly on pull requests as inline review comments - including one-click suggestions to fix them.</p>
</div>


---

## What it does

- Checks **internal links** (relative and root-relative paths) by verifying the file exists on disk
- Checks **same-org GitHub links** (`https://github.com/your-org/...`) via the GitHub API
- Checks **external HTTP/HTTPS links** with configurable timeout and retry logic
- On **pull requests**: posts inline review comments on the changed lines, with suggestion blocks you can apply in one click
- On **push / schedule**: writes a summary table to the workflow's Step Summary and emits warning annotations
- Never fails the workflow unless you explicitly opt in to strict mode

### Inline suggestions

When a broken internal link can be located elsewhere in the repo, HyperHawk suggests the correct path automatically. If the file was moved to a different folder but kept the same name, the fix is a one-click apply in the GitHub PR interface.

HyperHawk also flags working links that use relative paths (`../../docs/guide.md`) and suggests converting them to root-relative paths (`/docs/guide.md`). Root-relative links never break when the file containing them is moved.

---

## Quickstart

Add a workflow file to your repository:

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
      pull-requests: write  # required to post review comments

    steps:
      - uses: actions/checkout@v4

      - uses: your-org/hyperhawk@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

Replace `your-org/hyperhawk@v1` with the actual owner and tag of this repository once published.

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | yes | `${{ github.token }}` | GitHub token used for API calls and posting PR comments. The built-in `GITHUB_TOKEN` is sufficient for most cases. |
| `files` | no | `**/*.md,**/*.mdx` | Comma-separated glob patterns for files to scan. |
| `check-external` | no | `true` | Whether to check external HTTP/HTTPS links. Set to `false` to skip (useful if your runner has no outbound internet). |
| `check-same-org` | no | `true` | Whether to verify same-organisation GitHub links via the API. |
| `ignore-patterns` | no | _(empty)_ | Comma-separated list of regular expressions. Any link whose URL matches at least one pattern is skipped entirely. |
| `timeout` | no | `10000` | Timeout in milliseconds for each external link request. |
| `concurrency` | no | `5` | Number of links checked in parallel. Increase for large repos, decrease if you hit rate limits. |
| `strict` | no | `false` | Fail the workflow when broken links are found. See [Strict mode](#strict-mode). |

---

## Strict mode

By default HyperHawk **never fails the workflow**. It reports problems as comments and annotations but always exits with a success code. This lets teams adopt it incrementally without blocking CI.

To fail the workflow on broken links, enable strict mode in one of two ways:

**Per-workflow input:**

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    strict: true
```

**Repository secret (recommended for gradual rollout):**

Go to **Settings > Secrets and variables > Actions** and create a secret named `LINK_CHECK_STRICT` with the value `true`. Then pass it in the workflow:

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    strict: ${{ secrets.LINK_CHECK_STRICT }}
```

This way you can enable strict mode for specific repositories without changing the workflow file. Repositories without the secret continue to run in non-strict mode.

---

## Ignore patterns

The `ignore-patterns` input accepts a comma-separated list of JavaScript regular expressions. Any link URL that matches at least one pattern is skipped.

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    ignore-patterns: 'localhost,example\.com,^https://internal\.'
```

Common use cases:

- Skip placeholder URLs: `example\.com`
- Skip links that require authentication: `^https://internal-wiki\.`
- Skip localhost references: `localhost`
- Skip a known flaky external site while keeping everything else: `flaky-site\.io`

---

## Scanning scope

| Trigger | Files scanned |
|---------|--------------|
| `pull_request` | Only `.md` and `.mdx` files changed by the PR |
| `push` | All `.md` and `.mdx` files in the repository |
| `schedule` | All `.md` and `.mdx` files in the repository |

On pull requests, only changed files are scanned. Broken links in files that are not part of the diff are accumulated and posted as a single summary comment rather than inline comments.

The following directories are always excluded from scanning: `node_modules/`, `.git/`, `dist/`, `lib/`.

---

## PR review behaviour

HyperHawk posts a single `COMMENT`-type review (never `REQUEST_CHANGES`) so it never blocks merging. Each broken link becomes an inline comment on the affected line.

When a fix can be determined automatically, the comment includes a GitHub suggestion block:

> **HyperHawk** found a broken link: `/docs/old-path/guide.md`
> **Error:** File not found
>
> **Suggested fix:**
> ```suggestion
> See the [guide](/docs/new-path/guide.md) for details.
> ```

You can apply the suggestion directly from the GitHub UI with a single click.

When a working relative link is found, a separate suggestion recommends converting it to a root-relative path:

> **HyperHawk** suggests converting this relative link to a root-relative path so it stays valid if this file is moved.
> Current: `../../docs/guide.md`
>
> ```suggestion
> See the [guide](/docs/guide.md) for details.
> ```

---

## Permissions

The minimum permissions required are:

```yaml
permissions:
  contents: read
  pull-requests: write
```

`pull-requests: write` is only needed when the workflow runs on `pull_request` events. For push-only or schedule-only setups, `contents: read` is sufficient.

---

## Accessing private repositories in the same organisation

`GITHUB_TOKEN` is scoped to the repository the workflow runs in. It can reach **public** repos in the same org via the API, but for **private** repos it receives a `404` response - as if the repo does not exist. If HyperHawk reports same-org links as broken but you can confirm the repos are real, this is the cause.

To check links into private repos you need a token with broader access. There are three options:

### Option 1: Fine-grained Personal Access Token

Create a fine-grained PAT under **Settings > Developer settings > Personal access tokens > Fine-grained tokens**. Set the resource owner to your organisation, grant access to the relevant repositories (or all repositories), and give it `Contents: Read` permission. Store it as a secret and pass it to the action:

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.HYPERHAWK_PAT }}
```

Limitation: the token is tied to one person's account. If they leave the organisation, it stops working.

### Option 2: Classic Personal Access Token

Create a classic PAT with the `repo` scope. Same setup as above - store as a secret, pass via `token`. Simpler to create but broader in scope than necessary.

### Option 3: GitHub App (recommended for teams)

A GitHub App is not tied to any individual account, making it the right long-term solution for organisations.

1. Go to **Settings > Developer settings > GitHub Apps** and create a new app
2. Under permissions, grant `Contents: Read` (repository permission)
3. Install the app on your organisation and select which repositories it can access
4. Store the App ID and private key as secrets

Then generate a short-lived installation token at the start of each workflow run:

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ secrets.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}

- uses: your-org/hyperhawk@v1
  with:
    token: ${{ steps.app-token.outputs.token }}
```

The installation token is scoped to exactly the repositories you chose during app installation, expires after one hour, and can be revoked independently of any person's account.

---

## Examples

### Minimal setup

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
```

### Skip external link checking (air-gapped / restricted runners)

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    check-external: false
```

### Scan only a specific folder

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    files: 'docs/**/*.md'
```

### High-concurrency scan for large repos

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    concurrency: 20
    timeout: 15000
```

### Ignore specific domains and enable strict mode

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    ignore-patterns: 'localhost,example\.com'
    strict: true
```

---

## How link types are classified

| URL pattern | Classified as | How it is checked |
|-------------|--------------|-------------------|
| No scheme, starts with `.`, `/`, or `#` | Internal | File existence on disk (`fs.existsSync`) |
| `https://github.com/<same-owner>/...` | Same-org | GitHub REST API (`GET /repos`, `GET /repos/.../contents/...`) |
| Everything else | External | HTTP HEAD request, falling back to GET if HEAD returns 405 |

Each unique URL is checked only once per run, regardless of how many files reference it.

---

## Troubleshooting

**The action posts no comments on my PR.**
Ensure the workflow has `pull-requests: write` permission and that the `token` input is set (it defaults to `GITHUB_TOKEN` which should work in most cases).

**External links are timing out.**
Increase the `timeout` input (value is in milliseconds). The default is `10000` (10 seconds). Some sites are slow to respond to HEAD requests; HyperHawk falls back to GET automatically when HEAD returns 405.

**A link is reported as broken but it works in my browser.**
Some sites block requests from CI runners or require cookies. Add the domain to `ignore-patterns` to skip it.

**Same-org links to private repos are reported as broken even though the repos exist.**
`GITHUB_TOKEN` cannot access private repositories outside the current repo. The error will say "not accessible with the provided token". Switch to a fine-grained PAT or GitHub App token as described in [Accessing private repositories in the same organisation](#accessing-private-repositories-in-the-same-organisation).

**I get rate-limit errors for same-org checks.**
Reduce `concurrency` or provide a token with higher rate limits via a personal access token stored in a secret:

```yaml
- uses: your-org/hyperhawk@v1
  with:
    token: ${{ secrets.MY_PAT }}
```

**The action says a link is ambiguous and gives no suggestion.**
This means more than one file in the repo has the same filename. Rename one of them or update the link manually to include the full root-relative path.
