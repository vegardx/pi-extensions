# Raw API Operations

Use `gh api` when dedicated subcommands don't cover your need. It provides full access to the GitHub REST and GraphQL APIs.

## REST API

```bash
gh api <endpoint> [flags]
```

Key flags: `-X` (HTTP method), `-f` (string field), `-F` (typed field — numbers, bools, null), `--input` (JSON from file/stdin), `--jq` (filter response), `--paginate` (auto-paginate), `--slurp` (combine paginated results into array), `--cache` (cache duration), `-H` (headers)

### Placeholder substitution

`{owner}` and `{repo}` are auto-filled from the current directory's git remote:

```bash
# These are equivalent when in a repo checkout:
gh api repos/{owner}/{repo}/branches
gh api repos/my-org/my-repo/branches
```

### Common REST operations

```bash
# Get file contents at a ref
gh api repos/{owner}/{repo}/contents/path/to/file?ref=main

# List branches
gh api repos/{owner}/{repo}/branches --paginate --jq '.[].name'

# Get commit details
gh api repos/{owner}/{repo}/commits/abc123

# List tags
gh api repos/{owner}/{repo}/tags --jq '.[].name'

# Get team members
gh api orgs/my-org/teams/my-team/members --jq '.[].login'

# Create a label
gh api repos/{owner}/{repo}/labels -f name="priority:high" -f color="ff0000"

# Add reaction to issue
gh api repos/{owner}/{repo}/issues/42/reactions -f content="+1"

# Get deploy keys
gh api repos/{owner}/{repo}/keys --jq '.[].title'

# List org repos
gh api orgs/my-org/repos --paginate --jq '.[].full_name'
```

### Pagination

```bash
# Auto-paginate all pages into a single jq-filterable stream
gh api repos/{owner}/{repo}/issues --paginate --jq '.[].title'

# Slurp all pages into one JSON array
gh api repos/{owner}/{repo}/issues --paginate --slurp --jq 'flatten | length'
```

### POST / PATCH / DELETE

```bash
# POST with JSON body
gh api repos/{owner}/{repo}/issues -f title="New issue" -f body="Description"

# PATCH
gh api repos/{owner}/{repo}/issues/42 -X PATCH -f state="closed"

# DELETE
gh api repos/{owner}/{repo}/issues/42/lock -X DELETE

# POST from file
echo '{"title":"Issue","body":"Body"}' | gh api repos/{owner}/{repo}/issues --input -
```

## GraphQL API

```bash
gh api graphql -f query='<QUERY>' [-F var=value ...]
```

### Common GraphQL queries

```bash
# Get PR review threads
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 50) {
          nodes {
            isResolved
            comments(first: 10) {
              nodes { body author { login } }
            }
          }
        }
      }
    }
  }
' -F owner='{owner}' -F repo='{repo}' -F pr:=123

# Get project items (Projects v2)
gh api graphql -f query='
  query($org: String!, $number: Int!) {
    organization(login: $org) {
      projectV2(number: $number) {
        items(first: 50) {
          nodes {
            content {
              ... on Issue { title number state }
              ... on PullRequest { title number state }
            }
          }
        }
      }
    }
  }
' -F org="my-org" -F number:=1
```

### Variable typing

- `-f key=value` — string
- `-F key:=123` — integer
- `-F key:=true` — boolean
- `-F key:=null` — null

## Caching

```bash
# Cache response for 1 hour
gh api repos/{owner}/{repo}/branches --cache 1h
```
