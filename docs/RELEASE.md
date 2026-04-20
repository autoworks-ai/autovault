# Release Guide

This guide covers the minimum release workflow for AutoVault while the project
is still pre-1.0 and shipping as a stdio-only MCP server.

## Release Preconditions

Before cutting a release:

1. Ensure the branch is mergeable and review comments are addressed.
2. Ensure version and changelog entries are updated.
3. Run the local verification stack:

```bash
npm ci
npm run build
npm test -- --coverage
node scripts/smoke.mjs
node scripts/probe.mjs
docker build -t autoworks/autovault:test .
```

4. Confirm no critical vulnerabilities in production dependencies:

```bash
npm audit --omit=dev --audit-level=critical
```

## Versioning

AutoVault currently follows pre-1.0 semver:

- `0.x.0` for meaningful feature releases
- `0.x.y` for targeted bug fixes and hardening releases

Update both:

- `package.json`
- `package-lock.json`
- `CHANGELOG.md`

Recommended command:

```bash
npm version <new-version> --no-git-tag-version
```

## Merge / Tag Workflow

Once GitHub Actions is enabled for the repo, the preferred workflow is:

1. Merge the PR into `main`.
2. Pull the merge commit locally.
3. Create an annotated tag:

```bash
git checkout main
git pull origin main
git tag -a v0.2.0 -m "AutoVault v0.2.0"
git push origin v0.2.0
```

4. If using container images, build and publish from the tagged commit only.

## Rollback

AutoVault is a stdio process with filesystem-backed data, so rollback has two
parts: code rollback and storage preservation.

### Code rollback

If a release is bad:

1. Identify the last known-good commit or tag.
2. Rebuild the server from that revision.
3. Point the MCP host back at the rebuilt `dist/index.js` or the previous
   container image.

Example:

```bash
git checkout <known-good-tag-or-sha>
npm ci
npm run build
```

### Storage rollback

AutoVault does not currently run migrations. The recommended storage policy is:

- Back up `AUTOVAULT_STORAGE_PATH` before first use of a new release.
- Restore the backup if a release introduces bad on-disk skill content.

Example backup:

```bash
tar -czf autovault-backup-$(date +%F).tgz -C "$HOME" .autovault
```

Example restore:

```bash
rm -rf "$HOME/.autovault"
tar -xzf autovault-backup-<date>.tgz -C "$HOME"
```

## Release Checklist

- [ ] Version bumped in `package.json` and `package-lock.json`
- [ ] `CHANGELOG.md` updated
- [ ] Build passes
- [ ] Tests pass
- [ ] Smoke test passes
- [ ] Probe test passes
- [ ] Dependency audit passes at release threshold
- [ ] Previous release or commit identified for rollback
- [ ] Storage backup taken before first production use
