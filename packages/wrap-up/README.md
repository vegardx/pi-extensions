# pi-ext-wrap-up

Session handover commands: `/pause` and `/continue`.

## Commands

### `/pause`

End-of-session command. Produces a detailed handover document from session
history and git state, asks about cost-incurring resources, and saves to disk.

The handover file includes YAML frontmatter with structured metadata
(date, session ID, repo, branch, cwd) so that `/continue` can
automatically find the most relevant one later.

### `/continue`

Start-of-session command. Scans the handover directory for previous
handover files, ranks them by relevance to the current context (branch
match > repo match > recency), and injects the best match. The agent
then summarizes where things left off and asks how to proceed.

If multiple handovers tie for relevance, a picker is shown.

## Typical workflow

```
# End of session
/pause
  → agent writes handover doc with YAML frontmatter
  → asks about running resources
  → saves to ~/.pi/agent/handovers/handover-<date>-<id>.md

# Next session (same repo, same branch)
/continue
  → finds the most relevant handover
  → summarizes: goal, done, in-progress, blockers
  → asks: "Pick up next steps? Re-plan? Review?"
```

## Handover file format

```markdown
---
date: "2026-05-08"
session_id: "019df8aa"
repo: "git@github.com:vegardx/pi-extensions.git"
branch: "feat/webhook-support"
cwd: "/Users/vegardx/.pi/agent/handovers"
---

## Session Handover — 2026-05-08

### Goal
...

### Done
...

### In progress
...

### How to resume
...

### Next steps
...

### Blockers / open questions
...
```

## Scoring (how `/continue` picks the right file)

| Signal | Points |
|--------|--------|
| Exact branch match | +100 |
| Same repo (normalized) | +50 |
| Recency (0–9 days old) | +10 to +1 |

## Configuration

In `settings.json` under `extensionConfig.wrap-up`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `handoverDir` | string | `~/.pi/agent/handovers` | Directory for handover files |
| `autoSave` | boolean | `false` | Skip save confirmation in `/pause` |

## Resource signals detected

| Signal | Triggered by |
|--------|-------------|
| Terraform | `main.tf`, `terraform.tf`, `terraform/`, `infra/main.tf` |
| AWS CDK | `cdk.json` |
| Pulumi | `pulumi.yaml`, `pulumi.yml` |
| Docker | `Dockerfile` |
| Docker Compose | `docker-compose.yml/yaml`, `compose.yml/yaml` |
| GitHub Actions | `.github/workflows/` |
| Fly.io | `fly.toml`, `.fly/` |
| Vercel | `vercel.json`, `.vercel/` |
| Netlify | `netlify.toml` |
| Railway | `railway.toml` |
| Render | `render.yaml` |
| Kubernetes | `k8s/`, `kubernetes/` |
| Helm | `helm/`, `Chart.yaml` |
