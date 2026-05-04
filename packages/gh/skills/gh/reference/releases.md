# Release Operations

## Commands

### List releases

```bash
gh release list [flags]
```

Key flags: `--limit`, `--exclude-drafts`, `--exclude-pre-releases`

JSON fields: `createdAt, isDraft, isImmutable, isLatest, isPrerelease, name, publishedAt, tagName`

```bash
gh release list --limit 10
gh release list --json tagName,publishedAt,isPrerelease --limit 5
```

### View a release

```bash
# Latest release
gh release view

# Specific tag
gh release view v1.2.3

# JSON output
gh release view v1.2.3 --json tagName,body,assets,publishedAt

# Open in browser
gh release view v1.2.3 --web
```

### Create a release

```bash
# With auto-generated notes
gh release create v1.3.0 --generate-notes

# Draft release
gh release create v1.3.0 --draft --generate-notes

# Pre-release
gh release create v1.3.0-rc1 --prerelease --generate-notes

# With custom notes
gh release create v1.3.0 --title "v1.3.0" --notes "Release notes here"

# With notes from file
gh release create v1.3.0 --notes-file CHANGELOG.md

# With assets
gh release create v1.3.0 --generate-notes ./dist/app-linux ./dist/app-macos

# Target specific commit
gh release create v1.3.0 --target release-branch --generate-notes

# Latest flag control
gh release create v1.3.0 --latest=false --generate-notes
```

### Edit a release

```bash
gh release edit v1.3.0 --draft=false
gh release edit v1.3.0 --prerelease=false
gh release edit v1.3.0 --notes "Updated notes"
```

### Upload assets to existing release

```bash
gh release upload v1.3.0 ./dist/app-linux ./dist/app-macos
gh release upload v1.3.0 ./dist/*.tar.gz --clobber
```

### Download assets

```bash
# Download all assets
gh release download v1.3.0

# Download to directory
gh release download v1.3.0 --dir ./downloads

# Download specific asset by pattern
gh release download v1.3.0 --pattern "*.tar.gz"

# Download from latest
gh release download --pattern "*.zip"
```

### Delete a release

```bash
gh release delete v1.3.0
gh release delete v1.3.0 --cleanup-tag  # also delete the git tag
```
