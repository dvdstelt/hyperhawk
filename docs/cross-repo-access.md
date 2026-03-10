# Cross-repo access (private repositories)

`GITHUB_TOKEN` is scoped to the repository the workflow runs in. It can reach **public** repos in the same org via the API, but for **private** repos it receives a `404` response, as if the repo does not exist. If HyperHawk reports same-org links as broken but you can confirm the repos are real, this is the cause.

To check links into private repos you need a token with broader access. There are three options.

## Option 1: Fine-grained Personal Access Token

Create a fine-grained PAT under **Settings > Developer settings > Personal access tokens > Fine-grained tokens**. Set the resource owner to your organisation, grant access to the relevant repositories (or all repositories), and give it `Contents: Read` permission. Store it as a secret and pass it to the action:

```yaml
- uses: dvdstelt/hyperhawk@v1
  with:
    token: ${{ secrets.HYPERHAWK_PAT }}
```

Limitation: the token is tied to one person's account. If they leave the organisation, it stops working.

## Option 2: Classic Personal Access Token

Create a classic PAT with the `repo` scope. Same setup as above: store as a secret, pass via `token`. Simpler to create but broader in scope than necessary.

## Option 3: GitHub App (recommended)

A GitHub App is not tied to any individual account and works on both personal accounts and organisations.

1. Go to **Settings > Developer settings > GitHub Apps** and create a new app
2. Under permissions, grant `Contents: Read` (repository permission). No `Pull requests` permission needed on the app.
3. Disable the webhook (uncheck **Active** under Webhook)
4. Install the app on your account or organisation and select **All repositories** (or specific ones)
5. Store the App ID and private key as secrets

Pass the app token via `cross-repo-token` so that `GITHUB_TOKEN` (which holds `pull-requests: write`) continues to handle PR comments:

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

The `owner` input on `create-github-app-token` is required to generate a token scoped to all repos the app can access, rather than just the current repository.

The installation token expires after one hour and can be revoked independently of any person's account.
