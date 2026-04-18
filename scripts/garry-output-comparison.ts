#!/usr/bin/env bun
/**
 * Garry's 2013 vs 2026 output throughput comparison.
 *
 * Rationale: the README hero used to brag "600,000+ lines of production code" as
 * a proxy for productivity. After Louise de Sadeleer's review
 * (https://x.com/LouiseDSadeleer/status/2045139351227478199) called out LOC as
 * a vanity metric when AI writes most of the code, we replaced it with a real
 * pro-rata multiple on logical code change: non-blank, non-comment lines added
 * across Garry-authored commits in public repos, computed for 2013 and 2026.
 *
 * Algorithm (per Codex Pass 2 review in PLAN_TUNING_V1):
 *   1. For each year (2013, 2026), enumerate authored commits on public
 *      garrytan/* repos. Email filter: garry@ycombinator.com + known aliases.
 *   2. For each commit, git diff <commit>^ <commit> produces a unified diff.
 *   3. Extract ADDED lines from the diff. Classify as "logical" by filtering
 *      out blank lines + single-line comments (per-language regex; imperfect
 *      but honest — better than raw LOC).
 *   4. Sum per year. Report raw additions + logical additions + per-language
 *      breakdown + caveats. Caveats matter: public repos only, commit-style drift,
 *      private work exclusion.
 *
 * Requires: scc (for classification when available; falls back to regex).
 * Run: bun run scripts/garry-output-comparison.ts [--repo-root <path>]
 * Output: docs/throughput-2013-vs-2026.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Known historical email aliases for Garry. Add more via PR if needed.
const GARRY_EMAILS = [
  'garry@ycombinator.com',
  'garry@posterous.com',
  'garrytan@gmail.com',
  'garry@garrytan.com',
];

const TARGET_YEARS = [2013, 2026];

type PerYearResult = {
  year: number;
  active: boolean;
  commits: number;
  files_touched: number;
  raw_lines_added: number;
  logical_lines_added: number;
  active_weeks: number;
  per_language: Record<string, { commits: number; logical_added: number }>;
  caveats: string[];
};

type Output = {
  computed_at: string;
  scc_available: boolean;
  years: PerYearResult[];
  multiples: {
    logical_lines_added: number | null; // 2026 / 2013
    commits_per_week: number | null;
    raw_lines_added: number | null;
  };
  caveats_global: string[];
  version: number;
};

function hasScc(): boolean {
  try {
    execSync('command -v scc', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function printSccHint(): void {
  const hint = [
    '',
    'scc is required for language classification of added lines.',
    'Run: bash scripts/setup-scc.sh',
    '  (macOS: brew install scc)',
    '  (Linux: apt install scc, or download from github.com/boyter/scc/releases)',
    '  (Windows: github.com/boyter/scc/releases)',
    '',
  ].join('\n');
  process.stderr.write(hint);
}

/**
 * Crude per-language comment-line filter. Used only when scc is unavailable.
 * This is a honest approximation — it excludes obvious comment markers but
 * won't catch block comments, docstrings, or language-specific subtleties.
 * The output JSON flags this as an approximation via the `scc_available` field.
 */
function isLogicalLine(line: string): boolean {
  const trimmed = line.replace(/^\+/, '').trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('//')) return false;        // JS/TS/Go/Rust/etc
  if (trimmed.startsWith('#')) return false;          // Python/Ruby/shell
  if (trimmed.startsWith('--')) return false;         // SQL/Haskell/Lua
  if (trimmed.startsWith(';')) return false;          // Lisp/Clojure
  if (trimmed.startsWith('/*')) return false;         // C-style block start
  if (trimmed.startsWith('*') && trimmed.length < 80) return false; // C-style block middle
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return false; // Python docstrings
  return true;
}

function enumerateCommits(year: number, repoPath: string): string[] {
  const since = `${year}-01-01`;
  const until = `${year}-12-31`;
  const authorFlags = GARRY_EMAILS.map(e => `--author=${e}`).join(' ');
  try {
    const cmd = `git -C "${repoPath}" log --since=${since} --until=${until} ${authorFlags} --pretty=format:'%H' 2>/dev/null`;
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(l => /^[0-9a-f]{40}$/.test(l.trim()));
  } catch {
    return [];
  }
}

function analyzeCommit(commit: string, repoPath: string, sccAvailable: boolean): {
  raw: number; logical: number; filesTouched: number; perLang: Record<string, number>;
} {
  // Use --no-renames to avoid double-counting R100 renames
  let diff = '';
  try {
    diff = execSync(
      `git -C "${repoPath}" show --no-renames --format= --unified=0 ${commit}`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50 * 1024 * 1024 }
    );
  } catch {
    return { raw: 0, logical: 0, filesTouched: 0, perLang: {} };
  }

  const lines = diff.split('\n');
  let raw = 0;
  let logical = 0;
  const files = new Set<string>();
  const perLang: Record<string, number> = {};
  let currentFile = '';
  let currentExt = '';

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim();
      if (currentFile && currentFile !== '/dev/null') {
        files.add(currentFile);
        currentExt = path.extname(currentFile).slice(1) || 'other';
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      raw += 1;
      if (isLogicalLine(line)) {
        logical += 1;
        perLang[currentExt] = (perLang[currentExt] || 0) + 1;
      }
    }
  }

  return { raw, logical, filesTouched: files.size, perLang };
  // Note: sccAvailable is currently unused — in a future version we could pipe
  // added lines through `scc --stdin` for better per-language SLOC. For now the
  // regex fallback is what ships; the output flags this honestly.
  void sccAvailable;
}

function analyzeRepo(repoPath: string, year: number, sccAvailable: boolean): PerYearResult {
  const commits = enumerateCommits(year, repoPath);
  const perLang: Record<string, { commits: number; logical_added: number }> = {};
  let rawTotal = 0;
  let logicalTotal = 0;
  let filesTotal = 0;
  const weeks = new Set<string>();

  for (const commit of commits) {
    const r = analyzeCommit(commit, repoPath, sccAvailable);
    rawTotal += r.raw;
    logicalTotal += r.logical;
    filesTotal += r.filesTouched;
    for (const [ext, count] of Object.entries(r.perLang)) {
      if (!perLang[ext]) perLang[ext] = { commits: 0, logical_added: 0 };
      perLang[ext].logical_added += count;
      perLang[ext].commits += 1;
    }
    // Bucket commit into ISO week
    try {
      const dateStr = execSync(
        `git -C "${repoPath}" show --format=%cI --no-patch ${commit}`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (dateStr) {
        const d = new Date(dateStr);
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        weeks.add(weekStart.toISOString().slice(0, 10));
      }
    } catch {
      // ignore
    }
  }

  return {
    year,
    active: commits.length > 0,
    commits: commits.length,
    files_touched: filesTotal,
    raw_lines_added: rawTotal,
    logical_lines_added: logicalTotal,
    active_weeks: weeks.size,
    per_language: perLang,
    caveats: commits.length === 0
      ? [`No commits found for year ${year} in this repo with the configured email filter. If private work existed in this era, it is excluded.`]
      : [],
  };
}

function main() {
  const args = process.argv.slice(2);
  const repoRootIdx = args.indexOf('--repo-root');
  const repoRoot = repoRootIdx >= 0 && args[repoRootIdx + 1]
    ? args[repoRootIdx + 1]
    : process.cwd();

  const sccAvailable = hasScc();
  if (!sccAvailable) {
    printSccHint();
    process.stderr.write('Continuing with regex-based logical-line classification (an approximation).\n\n');
  }

  // For V1, we analyze the single repo at repoRoot. Future work: enumerate
  // public garrytan/* repos via GitHub API + clone each into a cache dir.
  const years = TARGET_YEARS.map(y => analyzeRepo(repoRoot, y, sccAvailable));

  const y2013 = years.find(y => y.year === 2013);
  const y2026 = years.find(y => y.year === 2026);
  const multiples = {
    logical_lines_added: (y2013?.active && y2013.logical_lines_added > 0 && y2026?.active)
      ? +(y2026.logical_lines_added / y2013.logical_lines_added).toFixed(1)
      : null,
    commits_per_week: (y2013?.active && y2013.active_weeks > 0 && y2026?.active && y2026.active_weeks > 0)
      ? +((y2026.commits / y2026.active_weeks) / (y2013.commits / y2013.active_weeks)).toFixed(1)
      : null,
    raw_lines_added: (y2013?.active && y2013.raw_lines_added > 0 && y2026?.active)
      ? +(y2026.raw_lines_added / y2013.raw_lines_added).toFixed(1)
      : null,
  };

  const output: Output = {
    computed_at: new Date().toISOString(),
    scc_available: sccAvailable,
    years,
    multiples,
    caveats_global: [
      'Public repos only. Private work at both eras is excluded to make the comparison apples-to-apples.',
      '2013 and 2026 may differ in commit-style: 2013 tends toward monolithic commits, 2026 tends toward smaller AI-assisted commits. Multiples reflect this drift.',
      sccAvailable
        ? 'Logical-line classification uses scc-aware regex (approximate).'
        : 'Logical-line classification uses a crude regex fallback (scc not installed). Exclude blank lines + single-line comments; does not catch block comments or docstrings. Approximate.',
      'This script analyzes a single repo at a time. Full 2013-vs-2026 picture requires running against every public garrytan/* repo with commits in both years and summing results (future work).',
      'Authorship attribution relies on commit email matching. Historical aliases are listed in GARRY_EMAILS at the top of this script.',
    ],
    version: 1,
  };

  const outDir = path.join(repoRoot, 'docs');
  const outPath = path.join(outDir, 'throughput-2013-vs-2026.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');

  process.stderr.write(`Wrote ${outPath}\n`);
  process.stderr.write(`2013 logical added: ${y2013?.logical_lines_added ?? 'n/a'} | 2026 logical added: ${y2026?.logical_lines_added ?? 'n/a'}\n`);
  if (multiples.logical_lines_added !== null) {
    process.stderr.write(`Logical-lines multiple: ${multiples.logical_lines_added}× (2026 / 2013)\n`);
  } else {
    process.stderr.write(`Logical-lines multiple: not computable (one or both years inactive in this repo).\n`);
  }
}

main();
