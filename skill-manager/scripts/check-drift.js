#!/usr/bin/env node
/**
 * check-drift.js — Scan skills.lock for upstream drift.
 *
 * For each skill with upstream tracking in skills.lock, fetches the current
 * HEAD SHA from GitHub and reports whether the skill is behind.
 *
 * Usage:
 *   node skill-manager/scripts/check-drift.js [--write-report] [--lock-path ./skills.lock]
 *
 * Flags:
 *   --write-report   Append drift status to each skill's CHANGELOG.md
 *   --lock-path      Override path to skills.lock (default: ./skills.lock)
 *
 * Exit codes:
 *   0  All skills up to date (or no tracked skills found)
 *   1  One or more skills have upstream drift
 *   2  Fatal error (network, config, etc.)
 *
 * Set GITHUB_TOKEN env var to avoid rate limiting.
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WRITE_REPORT = process.argv.includes('--write-report');

const lockPathFlag = process.argv.indexOf('--lock-path');
const LOCK_PATH = lockPathFlag !== -1
  ? resolve(process.argv[lockPathFlag + 1])
  : resolve(process.cwd(), 'skills.lock');

const REPO_ROOT = dirname(LOCK_PATH);

/** Minimal YAML parser for skills.lock — handles the subset we write. */
function parseLock(content) {
  const result = { version: '1', updated: null, skills: {} };
  let currentSkill = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#')) continue;

    // Top-level scalar
    const topMatch = line.match(/^(\w+):\s+"?([^"]*)"?\s*$/);
    if (topMatch && !line.startsWith(' ')) {
      const [, key, val] = topMatch;
      if (key === 'version') result.version = val;
      if (key === 'updated') result.updated = val;
      continue;
    }

    // Skill name (2-space indent, ends with colon)
    const skillMatch = line.match(/^  ([\w-]+):\s*$/);
    if (skillMatch) {
      currentSkill = skillMatch[1];
      result.skills[currentSkill] = {};
      continue;
    }

    // Skill field (4-space indent)
    const fieldMatch = line.match(/^    (\w+):\s+"?([^"]*)"?\s*$/);
    if (fieldMatch && currentSkill) {
      const [, key, val] = fieldMatch;
      result.skills[currentSkill][key] = val === 'null' ? null : val;
    }
  }

  return result;
}

/** Serialize skills.lock back to YAML. */
function serializeLock(lock) {
  const lines = [
    `version: "${lock.version}"`,
    `updated: "${new Date().toISOString()}"`,
    `skills:`,
  ];

  for (const [name, skill] of Object.entries(lock.skills)) {
    lines.push(`  ${name}:`);
    for (const [key, val] of Object.entries(skill)) {
      lines.push(`    ${key}: ${val === null ? 'null' : `"${val}"`}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Parse a GitHub blob URL into components.
 * Supports: https://github.com/org/repo/blob/main/path/to/file.md
 */
function parseGithubUrl(url) {
  const match = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], ref: match[3], path: match[4] };
}

/** Fetch the current HEAD commit SHA for a file path from the GitHub API. */
async function fetchCurrentSha(owner, repo, path) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'skills-check-drift/1.0',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${owner}/${repo}/${path}: ${body}`);
  }

  const commits = await res.json();
  if (!commits.length) throw new Error(`No commits found for ${owner}/${repo}/${path}`);
  return commits[0].sha;
}

async function appendChangelog(skillName, summary) {
  const changelogPath = resolve(REPO_ROOT, skillName, 'CHANGELOG.md');
  const date = new Date().toISOString().split('T')[0];
  const entry = `\n## ${date} — drift check\n\n${summary}\n`;

  if (!existsSync(changelogPath)) {
    await writeFile(changelogPath, `# ${skillName} Changelog\n${entry}`, 'utf8');
  } else {
    await appendFile(changelogPath, entry, 'utf8');
  }
}

async function main() {
  let lockContent;
  try {
    lockContent = await readFile(LOCK_PATH, 'utf8');
  } catch {
    console.error(`Error: skills.lock not found at ${LOCK_PATH}`);
    process.exit(2);
  }

  const lock = parseLock(lockContent);
  const tracked = Object.entries(lock.skills).filter(
    ([, skill]) => skill.upstream && skill.upstream_sha
  );

  if (!tracked.length) {
    console.log('No upstream-tracked skills found in skills.lock.');
    process.exit(0);
  }

  console.log(`Checking ${tracked.length} tracked skill(s)...\n`);

  const results = { upToDate: [], drifted: [], errors: [] };

  await Promise.all(
    tracked.map(async ([name, skill]) => {
      const parsed = parseGithubUrl(skill.upstream);
      if (!parsed) {
        results.errors.push({ name, error: `Cannot parse GitHub URL: ${skill.upstream}` });
        return;
      }

      try {
        const currentSha = await fetchCurrentSha(parsed.owner, parsed.repo, parsed.path);
        const isDrifted = currentSha !== skill.upstream_sha;

        lock.skills[name].last_checked = new Date().toISOString();

        if (isDrifted) {
          const compareUrl = `https://github.com/${parsed.owner}/${parsed.repo}/compare/${skill.upstream_sha}...${currentSha}`;
          results.drifted.push({ name, skill, currentSha, compareUrl });
        } else {
          results.upToDate.push({ name, skill });
        }
      } catch (err) {
        results.errors.push({ name, error: err.message });
      }
    })
  );

  // Print results
  if (results.upToDate.length) {
    console.log('✅ Up to date:');
    for (const { name, skill } of results.upToDate) {
      console.log(`   ${name} (v${skill.version})`);
    }
    console.log();
  }

  if (results.drifted.length) {
    console.log('⚠️  Drift detected:');
    for (const { name, skill, currentSha, compareUrl } of results.drifted) {
      console.log(`   ${name} (v${skill.version})`);
      console.log(`     Local SHA:    ${skill.upstream_sha}`);
      console.log(`     Upstream SHA: ${currentSha}`);
      console.log(`     Diff:         ${compareUrl}`);
    }
    console.log();
  }

  if (results.errors.length) {
    console.log('❌ Errors:');
    for (const { name, error } of results.errors) {
      console.log(`   ${name}: ${error}`);
    }
    console.log();
  }

  // Write per-skill CHANGELOG entries if requested
  if (WRITE_REPORT) {
    for (const { name, skill, currentSha, compareUrl } of results.drifted) {
      const summary = `- Drift detected: local \`${skill.upstream_sha.slice(0, 8)}\` vs upstream \`${currentSha.slice(0, 8)}\`\n- Diff: ${compareUrl}`;
      await appendChangelog(name, summary);
    }
    if (results.drifted.length) {
      console.log('Drift notes appended to each skill\'s CHANGELOG.md');
    }
  }

  // Persist updated last_checked timestamps
  await writeFile(LOCK_PATH, serializeLock(lock), 'utf8');

  process.exit(results.drifted.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(2);
});
