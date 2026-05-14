# Release Guide

This guide covers the minimum release workflow for AutoVault while the project
is still pre-1.0 and shipping local stdio plus remote Streamable HTTP MCP
entry points.

## Release Preconditions

Before cutting a release:

1. Ensure the branch is mergeable and review comments are addressed.
2. For normal releases, ensure the Release Please PR contains the generated
   version and changelog updates.
3. Run the local verification stack:

```bash
npm ci
npm run build
npm test -- --coverage
node scripts/smoke.mjs
node scripts/remote-smoke.mjs
node scripts/probe.mjs
docker build -t autoworks/autovault:test .
```

4. Confirm no critical vulnerabilities in production dependencies:

```bash
npm audit --omit=dev --audit-level=critical
```

5. Confirm npm trusted publishing is configured for
   <https://www.npmjs.com/package/@autoworks-ai/autovault>. Before the first
   public publish, this page may return 404; after the release workflow
   completes, it must resolve to the package and show the released version.

## Versioning

AutoVault currently follows pre-1.0 semver:

- `0.x.0` for meaningful feature releases
- `0.x.y` for targeted bug fixes and hardening releases

Release Please owns version bumps on `main`. For normal releases, do not bump
`package.json`, `package-lock.json`, `server.json`, or
`.release-please-manifest.json` by hand; merge conventional commits and let the
Release Please PR make those edits from the current manifest baseline.

For emergency manual releases only, update all versioned release metadata:

- `package.json`
- `package-lock.json`
- `server.json`
- `.release-please-manifest.json`
- `CHANGELOG.md`

Recommended command:

```bash
npm version <new-version> --no-git-tag-version
```

## Merge / Tag Workflow

The preferred workflow is:

1. Merge the launch or feature PR into `main`.
2. Let Release Please open or update the release PR.
3. Review the changelog, package version, manifest, and `server.json`.
4. Merge the Release Please PR after npm publishing is configured and approved.

Release Please creates the GitHub Release and tag. The container workflow then
publishes GHCR images from the tagged commit only. The npm publish job uses
trusted publishing for `@autoworks-ai/autovault` and should make the package
available at <https://www.npmjs.com/package/@autoworks-ai/autovault>.

## Rollback

AutoVault is filesystem-backed in both local stdio and remote service modes, so
rollback has two parts: code rollback and storage preservation.

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

- [ ] Release Please PR includes expected version updates for `package.json`,
      `package-lock.json`, `.release-please-manifest.json`, and `server.json`
- [ ] Release Please PR includes the expected `CHANGELOG.md` entry
- [ ] npm package page resolves after publish and shows the released version
- [ ] Build passes
- [ ] Tests pass
- [ ] Smoke test passes
- [ ] Probe test passes
- [ ] Dependency audit passes at release threshold
- [ ] Previous release or commit identified for rollback
- [ ] Storage backup taken before first production use
