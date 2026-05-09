## Summary

- 

## Verification

- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `node scripts/smoke.mjs`
- [ ] `node scripts/remote-smoke.mjs`
- [ ] `node scripts/probe.mjs`
- [ ] `docker build -t autovault:test .`

## Release Safety

- [ ] Does not change version or changelog files unless this is a Release Please PR
- [ ] Does not advertise npm install commands before npm publishing is live
- [ ] Does not push local `archive/*` tags
