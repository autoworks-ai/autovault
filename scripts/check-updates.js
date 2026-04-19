#!/usr/bin/env node
/**
 * check-updates.js — Scan skill files for upstream drift.
 *
 * For each skill with `upstream` + `upstream_sha` frontmatter, fetches the
 * current HEAD SHA from GitHub and reports whether the skill is behind.
 *
 * Usage:
 *   node scripts/check-updates.js [--write-report]
 *
 * Flags:
 *   --write-report   Write UPDATES.md to repo root in addition to stdout
 *
 * Exit codes:
 *   0  All skills up to date (or no tracked skills found)
 *   1  One or more skills have upstream changes available
 *   2  Fatal error (network, config, etc.)
 *
 * Set GITHUB_TOKEN env var to avoid rate limiting on private repos.
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

const SKILLS_DIR = resolve(import.meta.dirname, '..', 'skills');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WRITE_REPORT = process.argv.includes('--write-report');

/** Parse YAML frontmatter from markdown content. Returns an object or null. */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const fm = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) fm[key] = value;
  }
  return fm;
}

/**
 * Parse a GitHub blob URL into owner/repo/path components.
 * Supports:
 *   https://github.com/org/repo/blob/main/path/to/file.md
 *   https://github.com/org/repo/blob/<sha>/path/to/file.md
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
    'User-Agent': 'skills-check-updates/1.0',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status} for ${owner}/${repo}/${path}: ${body}`);
  }

  const commits = await res.json();
  if (!commits.length) throw new Error(`No commits found for ${owner}/${repo}/${path}`);
  return commits[0].sha;
}

/** Scan skills dir and return skill metadata for files that have upstream tracking. */
async function loadTrackedSkills() {
  let files;
  try {
    files = await readdir(SKILLS_DIR);
  } catch {
    console.error(`Error: skills directory not found at ${SKILLS_DIR}`);
    process.exit(2);
  }

  const skills = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = join(SKILLS_DIR, file);
    const content = await readFile(filePath, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.upstream || !fm.upstream_sha) continue;

    skills.push({
      file,
      filePath,
      title: fm.title || file,
      upstream: fm.upstream,
      upstream_sha: fm.upstream_sha,
      version: fm.version || '?',
    });
  }
  return skills;
}

async function main() {
  const skills = await loadTrackedSkills();

  if (!skills.length) {
    console.log('No skills with upstream tracking found.');
    process.exit(0);
  }

  console.log(`Checking ${skills.length} tracked skill(s)...\n`);

  const results = { upToDate: [], outdated: [], errors: [] };

  await Promise.all(
    skills.map(async (skill) => {
      const parsed = parseGithubUrl(skill.upstream);
      if (!parsed) {
        results.errors.push({ ...skill, error: `Cannot parse GitHub URL: ${skill.upstream}` });
        return;
      }

      try {
        const currentSha = await fetchCurrentSha(parsed.owner, parsed.repo, parsed.path);
        const isOutdated = currentSha !== skill.upstream_sha;

        if (isOutdated) {
          const compareUrl = `https://github.com/${parsed.owner}/${parsed.repo}/compare/${skill.upstream_sha}...${currentSha}`;
          results.outdated.push({ ...skill, currentSha, compareUrl });
        } else {
          results.upToDate.push(skill);
        }
      } catch (err) {
        results.errors.push({ ...skill, error: err.message });
      }
    })
  );

  // Print results
  if (results.upToDate.length) {
    console.log('✅ Up to date:');
    for (const s of results.upToDate) {
      console.log(`   ${s.file} (v${s.version})`);
    }
    console.log();
  }

  if (results.outdated.length) {
    console.log('⚠️  Updates available:');
    for (const s of results.outdated) {
      console.log(`   ${s.file} (v${s.version})`);
      console.log(`     Local SHA:    ${s.upstream_sha}`);
      console.log(`     Current SHA:  ${s.currentSha}`);
      console.log(`     Diff:         ${s.compareUrl}`);
    }
    console.log();
  }

  if (results.errors.length) {
    console.log('❌ Errors:');
    for (const s of results.errors) {
      console.log(`   ${s.file}: ${s.error}`);
    }
    console.log();
  }

  if (WRITE_REPORT) {
    const lines = [
      '# Skill Updates Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
    ];

    if (results.outdated.length) {
      lines.push('## Updates Available', '');
      for (const s of results.outdated) {
        lines.push(
          `### ${s.title}`,
          `- **File:** \`skills/${s.file}\``,
          `- **Local SHA:** \`${s.upstream_sha}\``,
          `- **Current SHA:** \`${s.currentSha}\``,
          `- **Diff:** [View changes](${s.compareUrl})`,
          `- **Upstream:** ${s.upstream}`,
          ''
        );
      }
    } else {
      lines.push('## All Skills Up to Date', '');
    }

    if (results.errors.length) {
      lines.push('## Errors', '');
      for (const s of results.errors) {
        lines.push(`- \`${s.file}\`: ${s.error}`);
      }
      lines.push('');
    }

    const reportPath = resolve(import.meta.dirname, '..', 'UPDATES.md');
    await writeFile(reportPath, lines.join('\n'), 'utf8');
    console.log(`Report written to UPDATES.md`);
  }

  process.exit(results.outdated.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(2);
});
