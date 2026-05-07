# pi-ext-wrap-up

End-of-session `/wrap-up` command for pi. Produces a detailed handover
document from session history and git state, asks about cost-incurring
resources, and offers to save everything to a file before you sign off.

## What it does

Run `/wrap-up` at the end of any session. The extension:

1. **Gathers context** synchronously — current branch, recent commits,
   working tree status, upstream tracking branch, PR info (via `gh`),
   and a scan for infrastructure/cloud resource signals.
2. **Triggers an agent turn** that:
   - Reviews the full session history for what was worked on
   - Writes a structured handover document:
     - Goal · Done · In progress · How to resume (exact steps) · Next steps · Blockers
   - For each detected resource signal, asks whether anything is running
     and should be stopped before signing off
   - Offers to save the document to `.pi/handover-<date>.md`

## Why detailed?

The handover is intentionally verbose. It assumes the next session starts
either from a compacted context or a completely fresh one — so it captures
load-bearing decisions, dead ends, file paths, commit SHAs, and exact
resume steps rather than a brief summary.

## Resource signals detected

| Signal | Triggered by |
|---|---|
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

## Usage

```
/wrap-up
```

No arguments. Run it at the end of a session before closing the terminal.

## The saved file

If you choose to save, the handover lands at `.pi/handover-<date>.md` in
your project root. Start the next session by reading it:

```
/new
Read .pi/handover-2026-05-06.md and continue where we left off.
```

Or add a startup skill that auto-loads it if it exists.
