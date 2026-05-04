# Search Operations

## Commands

### Search code

```bash
gh search code <query> [flags]
```

Key flags: `--owner`, `--repo`, `--language`, `--filename`, `--extension`, `--path`, `--limit`

JSON fields: `path, repository, sha, textMatches, url`

```bash
# Search for a function across an org
gh search code "func HandleRequest" --owner my-org

# Search in specific repo
gh search code "import pandas" --repo owner/repo

# Filter by language
gh search code "async function" --language typescript

# Filter by path
gh search code "DATABASE_URL" --repo owner/repo --path "config/"

# Filter by filename
gh search code "FROM node" --filename Dockerfile
```

### Search issues

```bash
gh search issues <query> [flags]
```

Key flags: `--owner`, `--repo`, `--assignee`, `--author`, `--label`, `--language`, `--state` (open/closed), `--created`, `--closed`, `--comments`, `--sort` (created/updated/comments/reactions), `--order`, `--limit`

```bash
# Bugs in an org
gh search issues "memory leak" --owner my-org --label "bug"

# Issues created recently
gh search issues "auth" --repo owner/repo --created ">YYYY-MM-DD"

# Issues with many comments (likely important)
gh search issues "performance" --owner my-org --sort comments --order desc
```

### Search pull requests

```bash
gh search prs <query> [flags]
```

Same flags as issues plus: `--draft`, `--merged`, `--review` (none/required/approved/changes_requested)

```bash
# Open PRs needing review
gh search prs "is:open review:required" --repo owner/repo

# Merged PRs by author
gh search prs "" --author username --merged --repo owner/repo --limit 20

# Draft PRs
gh search prs "" --draft --owner my-org --state open
```

### Search repositories

```bash
gh search repos <query> [flags]
```

Key flags: `--owner`, `--language`, `--license`, `--topic`, `--stars`, `--forks`, `--created`, `--archived`, `--visibility` (public/private/internal), `--sort` (stars/forks/updated/help-wanted-issues), `--limit`

```bash
# Repos by topic
gh search repos "" --topic kubernetes --owner my-org

# Popular repos
gh search repos "cli tool" --language go --stars ">100" --sort stars

# Internal repos in org
gh search repos "" --owner my-org --visibility internal
```

### Search commits

```bash
gh search commits <query> [flags]
```

Key flags: `--owner`, `--repo`, `--author`, `--committer`, `--author-date`, `--committer-date`, `--sort` (author-date/committer-date), `--order`, `--limit`

```bash
# Commits by author
gh search commits "fix" --author username --repo owner/repo

# Recent commits mentioning a topic
gh search commits "migration" --owner my-org --committer-date ">YYYY-MM-DD"
```

## Search syntax pitfalls

On Unix shells, exclusion queries require `--` to prevent flag parsing:

```bash
# WRONG — shell interprets -label as a flag
gh search issues "-label:bug"

# CORRECT
gh search issues -- "-label:bug"
```

Multi-word queries need quoting:

```bash
gh search code "import { useState }" --language typescript
```
