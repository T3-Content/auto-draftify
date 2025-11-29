import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const RESULTS_DIR = "results";

export type TestType = "scoring-test" | "1v1";

export interface TopicResults {
  topic: string;
  essays: Record<string, string>;
  feedback: Record<string, Record<string, string>>;
  revisions: Record<string, Record<string, string>>;
  scores: {
    original: Record<
      string,
      Record<string, { score: number; justification: string }>
    >;
    revised: Record<
      string,
      Record<string, Record<string, { score: number; justification: string }>>
    >;
  };
  rankings: {
    essays: Array<{
      type: "original" | "revised";
      author: string;
      reviewer?: string;
      avgScore: number;
    }>;
    reviewers: Array<{
      reviewer: string;
      avgImprovement: number;
    }>;
  };
}

export interface ArenaResults {
  timestamp: string;
  models: string[];
  topics: TopicResults[];
  aggregateRankings: {
    essays: Array<{
      author: string;
      avgScore: number;
      avgImprovement: number;
    }>;
    reviewers: Array<{
      reviewer: string;
      avgImprovement: number;
    }>;
  };
}

// 1v1 specific types
export interface ComparisonResult {
  judge: string;
  essayA: { author: string; reviewer?: string };
  essayB: { author: string; reviewer?: string };
  winner: "A" | "B" | "tie";
  reasoning: string;
}

export interface OneVsOneTopicResults {
  topic: string;
  essays: Record<string, string>;
  feedback: Record<string, Record<string, string>>;
  revisions: Record<string, Record<string, string>>;
  comparisons: ComparisonResult[];
  rankings: {
    essays: Array<{
      author: string;
      reviewer?: string;
      wins: number;
      losses: number;
      ties: number;
      winRate: number;
    }>;
  };
}

export interface OneVsOneResults {
  timestamp: string;
  models: string[];
  topics: OneVsOneTopicResults[];
  aggregateRankings: {
    essays: Array<{
      author: string;
      wins: number;
      losses: number;
      ties: number;
      winRate: number;
    }>;
    reviewers: Array<{
      reviewer: string;
      wins: number;
      losses: number;
      ties: number;
      winRate: number;
    }>;
    pairings: Array<{
      author: string;
      reviewer: string;
      wins: number;
      losses: number;
      ties: number;
      winRate: number;
    }>;
  };
}

/**
 * Generates a timestamp string for filenames.
 */
function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
}

/**
 * Sanitizes a name for use in filenames.
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
}

/**
 * Creates the arena results directory structure for a topic.
 */
export async function createTopicDirectories(baseDir: string, topic: string) {
  const topicSlug = sanitizeName(topic).slice(0, 50);
  const topicDir = join(baseDir, topicSlug);
  const dirs = [
    topicDir,
    join(topicDir, "essays"),
    join(topicDir, "feedback"),
    join(topicDir, "revisions"),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  return topicDir;
}

/**
 * Writes an essay to the essays directory.
 */
export async function writeEssay(
  topicDir: string,
  modelName: string,
  essay: string
) {
  const filename = `${sanitizeName(modelName)}.md`;
  const path = join(topicDir, "essays", filename);
  await writeFile(path, `# Essay by ${modelName}\n\n${essay}`, "utf-8");
  return path;
}

/**
 * Writes feedback to the feedback directory.
 */
export async function writeFeedback(
  topicDir: string,
  reviewer: string,
  author: string,
  feedback: string
) {
  const filename = `${sanitizeName(reviewer)}-on-${sanitizeName(author)}.md`;
  const path = join(topicDir, "feedback", filename);
  await writeFile(
    path,
    `# Feedback by ${reviewer} on ${author}'s Essay\n\n${feedback}`,
    "utf-8"
  );
  return path;
}

/**
 * Writes a revision to the revisions directory.
 */
export async function writeRevision(
  topicDir: string,
  author: string,
  reviewer: string,
  revision: string
) {
  const filename = `${sanitizeName(author)}-revised-by-${sanitizeName(
    reviewer
  )}.md`;
  const path = join(topicDir, "revisions", filename);
  await writeFile(
    path,
    `# ${author}'s Essay Revised Based on ${reviewer}'s Feedback\n\n${revision}`,
    "utf-8"
  );
  return path;
}

/**
 * Writes the complete results JSON file.
 */
export async function writeResultsJson(baseDir: string, results: ArenaResults) {
  const path = join(baseDir, "results.json");
  await writeFile(path, JSON.stringify(results, null, 2), "utf-8");
  return path;
}

/**
 * Generates and writes the summary markdown file.
 */
export async function writeSummary(baseDir: string, results: ArenaResults) {
  const path = join(baseDir, "summary.md");

  let content = `# Writing Quality Arena Results\n\n`;
  content += `**Date:** ${results.timestamp}\n\n`;
  content += `**Models:** ${results.models.length}\n\n`;
  content += `**Topics:** ${results.topics.length}\n\n`;

  // Aggregate Model Rankings (as writers)
  content += `## Aggregate Model Rankings (as Writers)\n\n`;
  content += `| Rank | Model | Avg Score | Avg Improvement |\n`;
  content += `|------|-------|-----------|----------------|\n`;

  results.aggregateRankings.essays.forEach((entry, index) => {
    const sign = entry.avgImprovement >= 0 ? "+" : "";
    content += `| ${index + 1} | ${entry.author} | ${entry.avgScore.toFixed(
      2
    )} | ${sign}${entry.avgImprovement.toFixed(2)} |\n`;
  });

  // Aggregate Reviewer Rankings
  content += `\n## Aggregate Reviewer Rankings (by Improvement Impact)\n\n`;
  content += `| Rank | Reviewer | Avg Improvement |\n`;
  content += `|------|----------|----------------|\n`;

  results.aggregateRankings.reviewers.forEach((entry, index) => {
    const sign = entry.avgImprovement >= 0 ? "+" : "";
    content += `| ${index + 1} | ${
      entry.reviewer
    } | ${sign}${entry.avgImprovement.toFixed(2)} |\n`;
  });

  // Per-topic summaries
  content += `\n## Per-Topic Results\n\n`;

  for (const topic of results.topics) {
    content += `### ${topic.topic}\n\n`;

    // Top 3 essays for this topic
    content += `**Top 3 Essays:**\n`;
    topic.rankings.essays.slice(0, 3).forEach((entry, index) => {
      const reviewer = entry.reviewer ? ` (← ${entry.reviewer})` : "";
      content += `${index + 1}. ${entry.author}${reviewer} [${
        entry.type
      }] - ${entry.avgScore.toFixed(2)}\n`;
    });

    // Top 3 reviewers for this topic
    content += `\n**Top 3 Reviewers:**\n`;
    topic.rankings.reviewers.slice(0, 3).forEach((entry, index) => {
      const sign = entry.avgImprovement >= 0 ? "+" : "";
      content += `${index + 1}. ${
        entry.reviewer
      } - ${sign}${entry.avgImprovement.toFixed(2)}\n`;
    });

    content += `\n`;
  }

  await writeFile(path, content, "utf-8");
  return path;
}

/**
 * Creates a new arena run and returns the base directory and timestamp.
 */
export async function initArenaRun(testType: TestType) {
  const timestamp = getTimestamp();
  const baseDir = join(RESULTS_DIR, testType, timestamp);
  await mkdir(baseDir, { recursive: true });
  return { baseDir, timestamp };
}

/**
 * Writes a comparison result to the comparisons directory.
 */
export async function writeComparison(
  topicDir: string,
  judge: string,
  essayA: { author: string; reviewer?: string },
  essayB: { author: string; reviewer?: string },
  winner: "A" | "B" | "tie",
  reasoning: string
) {
  const comparisonsDir = join(topicDir, "comparisons");
  await mkdir(comparisonsDir, { recursive: true });

  const essayALabel = essayA.reviewer
    ? `${sanitizeName(essayA.author)}-revised-by-${sanitizeName(
        essayA.reviewer
      )}`
    : sanitizeName(essayA.author);
  const essayBLabel = essayB.reviewer
    ? `${sanitizeName(essayB.author)}-revised-by-${sanitizeName(
        essayB.reviewer
      )}`
    : sanitizeName(essayB.author);

  const filename = `${sanitizeName(judge)}-${essayALabel}-vs-${essayBLabel}.md`;
  const path = join(comparisonsDir, filename);

  const essayADisplay = essayA.reviewer
    ? `${essayA.author} (revised by ${essayA.reviewer})`
    : essayA.author;
  const essayBDisplay = essayB.reviewer
    ? `${essayB.author} (revised by ${essayB.reviewer})`
    : essayB.author;

  const winnerDisplay =
    winner === "A" ? essayADisplay : winner === "B" ? essayBDisplay : "Tie";

  await writeFile(
    path,
    `# Comparison by ${judge}\n\n**Essay A:** ${essayADisplay}\n**Essay B:** ${essayBDisplay}\n\n**Winner:** ${winnerDisplay}\n\n## Reasoning\n\n${reasoning}`,
    "utf-8"
  );
  return path;
}

/**
 * Writes the 1v1 results JSON file.
 */
export async function writeOneVsOneResultsJson(
  baseDir: string,
  results: OneVsOneResults
) {
  const path = join(baseDir, "results.json");
  await writeFile(path, JSON.stringify(results, null, 2), "utf-8");
  return path;
}

/**
 * Generates and writes the 1v1 summary markdown file.
 */
export async function writeOneVsOneSummary(
  baseDir: string,
  results: OneVsOneResults
) {
  const path = join(baseDir, "summary.md");

  let content = `# 1v1 Arena Results\n\n`;
  content += `**Date:** ${results.timestamp}\n\n`;
  content += `**Models:** ${results.models.length}\n\n`;
  content += `**Topics:** ${results.topics.length}\n\n`;

  // Aggregate Model Rankings (as Writers)
  content += `## Aggregate Model Rankings (as Writers)\n\n`;
  content += `| Rank | Model | Wins | Losses | Ties | Win Rate |\n`;
  content += `|------|-------|------|--------|------|----------|\n`;

  results.aggregateRankings.essays.forEach((entry, index) => {
    content += `| ${index + 1} | ${entry.author} | ${entry.wins} | ${
      entry.losses
    } | ${entry.ties} | ${(entry.winRate * 100).toFixed(1)}% |\n`;
  });

  // Aggregate Reviewer Rankings
  content += `\n## Aggregate Reviewer Rankings\n\n`;
  content += `| Rank | Reviewer | Wins | Losses | Ties | Win Rate |\n`;
  content += `|------|----------|------|--------|------|----------|\n`;

  results.aggregateRankings.reviewers.forEach((entry, index) => {
    content += `| ${index + 1} | ${entry.reviewer} | ${entry.wins} | ${
      entry.losses
    } | ${entry.ties} | ${(entry.winRate * 100).toFixed(1)}% |\n`;
  });

  // Aggregate Pairing Rankings
  content += `\n## Aggregate Pairing Rankings (Author + Reviewer)\n\n`;
  content += `| Rank | Author | Reviewer | Wins | Losses | Ties | Win Rate |\n`;
  content += `|------|--------|----------|------|--------|------|----------|\n`;

  results.aggregateRankings.pairings.forEach((entry, index) => {
    content += `| ${index + 1} | ${entry.author} | ${entry.reviewer} | ${
      entry.wins
    } | ${entry.losses} | ${entry.ties} | ${(entry.winRate * 100).toFixed(
      1
    )}% |\n`;
  });

  // Per-topic summaries
  content += `\n## Per-Topic Results\n\n`;

  for (const topic of results.topics) {
    content += `### ${topic.topic}\n\n`;

    content += `| Rank | Essay | Wins | Losses | Ties | Win Rate |\n`;
    content += `|------|-------|------|--------|------|----------|\n`;

    topic.rankings.essays.forEach((entry, index) => {
      const label = entry.reviewer
        ? `${entry.author} (← ${entry.reviewer})`
        : entry.author;
      content += `| ${index + 1} | ${label} | ${entry.wins} | ${
        entry.losses
      } | ${entry.ties} | ${(entry.winRate * 100).toFixed(1)}% |\n`;
    });

    content += `\n`;
  }

  await writeFile(path, content, "utf-8");
  return path;
}
