import pLimit from "p-limit";
import {
  generateEssay,
  reviewEssay,
  reviseEssay,
  scoreEssay,
  compareEssays,
  type TokenUsage,
} from "./aiClient";
import {
  modelsToRun as allModels,
  dryRunModels,
  API_STAGGER_JITTER_MS,
  API_STAGGER_MS,
  PARALLEL_LIMIT,
  TOPICS,
} from "./constants";
import {
  createTopicDirectories,
  initArenaRun,
  writeEssay,
  writeFeedback,
  writeResultsJson,
  writeRevision,
  writeSummary,
  writeComparison,
  writeOneVsOneResultsJson,
  writeOneVsOneSummary,
  type ArenaResults,
  type TopicResults,
  type TestType,
  type OneVsOneResults,
  type OneVsOneTopicResults,
  type ComparisonResult,
} from "./fileUtils";

// Parse CLI flags
const isDryRun = process.argv.includes("--dry-run");
const modelsToRun = isDryRun ? dryRunModels : allModels;
const reviewerModels = modelsToRun.filter((m) => m.reviewer);
const comparisonJudges =
  reviewerModels.length > 0 ? reviewerModels : modelsToRun;

// Parse --test argument
function getTestTypeFromArgs(): TestType | null {
  const testArg = process.argv.find((arg) => arg.startsWith("--test="));
  if (!testArg) return null;
  const value = testArg.split("=")[1];
  if (value === "scoring-test" || value === "1v1") {
    return value;
  }
  console.error(`Invalid test type: ${value}. Use "scoring-test" or "1v1".`);
  process.exit(1);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a per-phase limiter that keeps concurrency high, but staggers
 * request start times to avoid huge bursts at time 0.
 */
function createApiLimit() {
  const limit = pLimit(PARALLEL_LIMIT);
  let started = 0;

  return async function runLimited<T>(fn: () => Promise<T>) {
    return limit(async () => {
      const slot = started % PARALLEL_LIMIT;
      started++;

      const jitter =
        API_STAGGER_JITTER_MS > 0
          ? Math.floor(Math.random() * (API_STAGGER_JITTER_MS + 1))
          : 0;
      const delay = slot * API_STAGGER_MS + jitter;

      if (delay > 0) {
        await sleep(delay);
      }

      return fn();
    });
  };
}

/**
 * Tracks token usage and costs per model per phase.
 */
interface UsageTracker {
  essays: Record<string, TokenUsage[]>;
  reviews: Record<string, TokenUsage[]>;
  revisions: Record<string, TokenUsage[]>;
  scores: Record<string, TokenUsage[]>;
  comparisons: Record<string, TokenUsage[]>;
}

function createUsageTracker(): UsageTracker {
  const tracker: UsageTracker = {
    essays: {},
    reviews: {},
    revisions: {},
    scores: {},
    comparisons: {},
  };
  for (const model of modelsToRun) {
    tracker.essays[model.name] = [];
    tracker.reviews[model.name] = [];
    tracker.revisions[model.name] = [];
    tracker.scores[model.name] = [];
    tracker.comparisons[model.name] = [];
  }
  return tracker;
}

let usageTracker = createUsageTracker();

/**
 * Interactive test type selection UI.
 */
async function selectTestType(): Promise<TestType> {
  console.log("\n🏟️  Writing Quality Arena\n");
  console.log("Select test type:\n");
  console.log("  1. scoring-test - Models score essays on a 1-10 scale");
  console.log("  2. 1v1          - Head-to-head essay comparisons\n");

  process.stdout.write("Enter choice (1 or 2): ");

  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      const input = data.toString().trim();
      if (input === "1" || input === "scoring-test") {
        resolve("scoring-test");
      } else if (input === "2" || input === "1v1") {
        resolve("1v1");
      } else {
        console.log("Invalid choice, defaulting to scoring-test");
        resolve("scoring-test");
      }
    });
  });
}

// ============================================================================
// SHARED PHASES (used by both test types)
// ============================================================================

/**
 * Phase 1: Each model generates an essay on the topic.
 */
async function runPhase1Essays(
  topic: string,
  topicDir: string
): Promise<Record<string, string>> {
  const limit = createApiLimit();
  const essays: Record<string, string> = {};

  const tasks = modelsToRun.map((model) =>
    limit(async () => {
      console.log(`    Generating essay: ${model.name}...`);
      const result = await generateEssay(model, topic);
      if (!result) {
        return null;
      }
      essays[model.name] = result.text;
      usageTracker.essays[model.name]!.push(result.usage);
      await writeEssay(topicDir, model.name, result.text);
      console.log(
        `    ✓ ${model.name} (${
          result.usage.totalTokens
        } tokens, $${result.usage.cost.toFixed(4)})`
      );
      return result;
    })
  );

  await Promise.all(tasks);
  return essays;
}

/**
 * Phase 2: Every model reviews every OTHER model's essay.
 */
async function runPhase2Feedback(
  topic: string,
  essays: Record<string, string>,
  topicDir: string
): Promise<Record<string, Record<string, string>>> {
  const limit = createApiLimit();
  const feedback: Record<string, Record<string, string>> = {};

  // Initialize nested objects
  for (const reviewer of modelsToRun) {
    feedback[reviewer.name] = {};
  }

  const tasks: Array<Promise<void>> = [];

  for (const reviewer of modelsToRun) {
    for (const author of modelsToRun) {
      if (reviewer.name === author.name) continue;
      // Skip if no essay exists for this author
      if (!essays[author.name]) continue;

      tasks.push(
        limit(async () => {
          console.log(`    ${reviewer.name} reviewing ${author.name}...`);
          const essayText = essays[author.name]!;
          const result = await reviewEssay(reviewer, essayText, topic);
          if (!result) {
            return;
          }
          feedback[reviewer.name]![author.name] = result.text;
          usageTracker.reviews[reviewer.name]!.push(result.usage);
          await writeFeedback(
            topicDir,
            reviewer.name,
            author.name,
            result.text
          );
          console.log(
            `    ✓ ${reviewer.name} → ${author.name} (${
              result.usage.totalTokens
            } tokens, $${result.usage.cost.toFixed(4)})`
          );
        })
      );
    }
  }

  await Promise.all(tasks);
  return feedback;
}

/**
 * Phase 3: Each author revises their essay for EACH piece of feedback received.
 */
async function runPhase3Revisions(
  topic: string,
  essays: Record<string, string>,
  feedback: Record<string, Record<string, string>>,
  topicDir: string
): Promise<Record<string, Record<string, string>>> {
  const limit = createApiLimit();
  const revisions: Record<string, Record<string, string>> = {};

  // Initialize nested objects
  for (const author of modelsToRun) {
    revisions[author.name] = {};
  }

  const tasks: Array<Promise<void>> = [];

  for (const author of modelsToRun) {
    for (const reviewer of modelsToRun) {
      if (author.name === reviewer.name) continue;
      // Skip if no essay or no feedback exists
      if (!essays[author.name]) continue;
      if (!feedback[reviewer.name]?.[author.name]) continue;

      tasks.push(
        limit(async () => {
          const reviewerFeedback = feedback[reviewer.name]![author.name]!;
          const essayText = essays[author.name]!;
          console.log(
            `    ${author.name} revising based on ${reviewer.name}...`
          );
          const result = await reviseEssay(
            author,
            topic,
            essayText,
            reviewerFeedback
          );
          if (!result) {
            return;
          }
          revisions[author.name]![reviewer.name] = result.text;
          usageTracker.revisions[author.name]!.push(result.usage);
          await writeRevision(
            topicDir,
            author.name,
            reviewer.name,
            result.text
          );
          console.log(
            `    ✓ ${author.name} ← ${reviewer.name} (${
              result.usage.totalTokens
            } tokens, $${result.usage.cost.toFixed(4)})`
          );
        })
      );
    }
  }

  await Promise.all(tasks);
  return revisions;
}

// ============================================================================
// SCORING TEST SPECIFIC
// ============================================================================

/**
 * Counts API calls for scoring test.
 */
function countScoringApiCalls() {
  let essays = 0;
  let feedback = 0;
  let revisions = 0;
  let scores = 0;

  for (const _topic of TOPICS) {
    for (const _model of modelsToRun) {
      essays++;
    }

    for (const reviewer of modelsToRun) {
      for (const author of modelsToRun) {
        if (reviewer.name === author.name) continue;
        feedback++;
      }
    }

    for (const author of modelsToRun) {
      for (const reviewer of modelsToRun) {
        if (author.name === reviewer.name) continue;
        revisions++;
      }
    }

    for (const _judge of modelsToRun) {
      for (const _author of modelsToRun) {
        scores++;
      }
    }
    for (const _judge of modelsToRun) {
      for (const author of modelsToRun) {
        for (const reviewer of modelsToRun) {
          if (author.name === reviewer.name) continue;
          scores++;
        }
      }
    }
  }

  return {
    essays,
    feedback,
    revisions,
    scores,
    total: essays + feedback + revisions + scores,
  };
}

/**
 * Prompts for scoring test confirmation.
 */
async function confirmScoringRun(): Promise<boolean> {
  const { essays, feedback, revisions, scores, total } = countScoringApiCalls();

  console.log("\n🏟️  Writing Quality Arena - Scoring Test\n");
  if (isDryRun) {
    console.log("⚡ DRY RUN MODE (using cheap models)\n");
  }
  console.log(`Models: ${modelsToRun.length}`);
  console.log(`Topics: ${TOPICS.length}`);
  console.log(`\nAPI Call Breakdown (across all ${TOPICS.length} topics):`);
  console.log(`  Phase 1 - Essays:    ${essays.toString().padStart(6)} calls`);
  console.log(
    `  Phase 2 - Feedback:  ${feedback.toString().padStart(6)} calls`
  );
  console.log(
    `  Phase 3 - Revisions: ${revisions.toString().padStart(6)} calls`
  );
  console.log(`  Phase 4 - Scores:    ${scores.toString().padStart(6)} calls`);
  console.log(`  ────────────────────────────`);
  console.log(`  Total:               ${total.toString().padStart(6)} calls\n`);
  console.log(`Parallelism: ${PARALLEL_LIMIT} concurrent requests\n`);

  process.stdout.write("Proceed? (Y/n): ");

  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      const input = data.toString().trim().toLowerCase();
      resolve(input === "" || input === "y" || input === "yes");
    });
  });
}

/**
 * Phase 4 (Scoring): Every model scores every essay.
 */
async function runPhase4Scoring(
  topic: string,
  essays: Record<string, string>,
  revisions: Record<string, Record<string, string>>
): Promise<{
  original: Record<
    string,
    Record<string, { score: number; justification: string }>
  >;
  revised: Record<
    string,
    Record<string, Record<string, { score: number; justification: string }>>
  >;
}> {
  const limit = createApiLimit();
  const originalScores: Record<
    string,
    Record<string, { score: number; justification: string }>
  > = {};
  const revisedScores: Record<
    string,
    Record<string, Record<string, { score: number; justification: string }>>
  > = {};

  for (const judge of modelsToRun) {
    originalScores[judge.name] = {};
    revisedScores[judge.name] = {};
    for (const author of modelsToRun) {
      revisedScores[judge.name]![author.name] = {};
    }
  }

  const tasks: Array<Promise<void>> = [];

  for (const judge of modelsToRun) {
    for (const author of modelsToRun) {
      // Skip if no essay exists for this author
      if (!essays[author.name]) continue;

      tasks.push(
        limit(async () => {
          const essayText = essays[author.name]!;
          console.log(`    ${judge.name} scoring ${author.name} (original)...`);
          const result = await scoreEssay(judge, essayText, topic);
          if (!result) {
            return;
          }
          originalScores[judge.name]![author.name] = {
            score: result.score,
            justification: result.justification,
          };
          usageTracker.scores[judge.name]!.push(result.usage);
          console.log(
            `    ✓ ${judge.name} → ${author.name} (original): ${
              result.score
            } (${result.usage.totalTokens} tokens, $${result.usage.cost.toFixed(
              4
            )})`
          );
        })
      );
    }
  }

  for (const judge of modelsToRun) {
    for (const author of modelsToRun) {
      for (const reviewer of modelsToRun) {
        if (author.name === reviewer.name) continue;
        // Skip if no revision exists
        if (!revisions[author.name]?.[reviewer.name]) continue;

        tasks.push(
          limit(async () => {
            const revision = revisions[author.name]![reviewer.name]!;
            console.log(
              `    ${judge.name} scoring ${author.name}←${reviewer.name} (revised)...`
            );
            const result = await scoreEssay(judge, revision, topic);
            if (!result) {
              return;
            }
            revisedScores[judge.name]![author.name]![reviewer.name] = {
              score: result.score,
              justification: result.justification,
            };
            usageTracker.scores[judge.name]!.push(result.usage);
            console.log(
              `    ✓ ${judge.name} → ${author.name}←${reviewer.name}: ${
                result.score
              } (${
                result.usage.totalTokens
              } tokens, $${result.usage.cost.toFixed(4)})`
            );
          })
        );
      }
    }
  }

  await Promise.all(tasks);
  return { original: originalScores, revised: revisedScores };
}

/**
 * Calculate rankings from scores for a single topic.
 */
function calculateScoringRankings(scores: {
  original: Record<
    string,
    Record<string, { score: number; justification: string }>
  >;
  revised: Record<
    string,
    Record<string, Record<string, { score: number; justification: string }>>
  >;
}): TopicResults["rankings"] {
  const essayScores: Array<{
    type: "original" | "revised";
    author: string;
    reviewer?: string;
    avgScore: number;
  }> = [];

  const judges = Object.keys(scores.original);
  if (judges.length === 0) {
    return { essays: [], reviewers: [] };
  }

  // Collect all authors that have at least one score
  const allAuthors = new Set<string>();
  for (const judge of judges) {
    for (const author of Object.keys(scores.original[judge] ?? {})) {
      allAuthors.add(author);
    }
  }
  const authors = Array.from(allAuthors);

  for (const author of authors) {
    const judgeScoresRaw = judges
      .map((j) => scores.original[j]?.[author]?.score)
      .filter((s): s is number => s !== undefined);
    if (judgeScoresRaw.length === 0) continue;
    const avgScore =
      judgeScoresRaw.reduce((a, b) => a + b, 0) / judgeScoresRaw.length;
    essayScores.push({ type: "original", author, avgScore });
  }

  for (const author of authors) {
    for (const reviewer of authors) {
      if (author === reviewer) continue;
      const judgeScoresRaw = judges
        .map((j) => scores.revised[j]?.[author]?.[reviewer]?.score)
        .filter((s): s is number => s !== undefined);
      if (judgeScoresRaw.length === 0) continue;
      const avgScore =
        judgeScoresRaw.reduce((a, b) => a + b, 0) / judgeScoresRaw.length;
      essayScores.push({ type: "revised", author, reviewer, avgScore });
    }
  }

  essayScores.sort((a, b) => b.avgScore - a.avgScore);

  const reviewerImpact: Record<string, number[]> = {};
  for (const reviewer of authors) {
    reviewerImpact[reviewer] = [];
  }

  for (const author of authors) {
    const originalScoresRaw = judges
      .map((j) => scores.original[j]?.[author]?.score)
      .filter((s): s is number => s !== undefined);
    if (originalScoresRaw.length === 0) continue;
    const originalAvg =
      originalScoresRaw.reduce((a, b) => a + b, 0) / originalScoresRaw.length;

    for (const reviewer of authors) {
      if (author === reviewer) continue;
      const revisedScoresRaw = judges
        .map((j) => scores.revised[j]?.[author]?.[reviewer]?.score)
        .filter((s): s is number => s !== undefined);
      if (revisedScoresRaw.length === 0) continue;
      const revisedAvg =
        revisedScoresRaw.reduce((a, b) => a + b, 0) / revisedScoresRaw.length;
      const improvement = revisedAvg - originalAvg;
      reviewerImpact[reviewer]!.push(improvement);
    }
  }

  const reviewerScores = Object.entries(reviewerImpact)
    .filter(([, improvements]) => improvements.length > 0)
    .map(([reviewer, improvements]) => ({
      reviewer,
      avgImprovement:
        improvements.reduce((a, b) => a + b, 0) / improvements.length,
    }));

  reviewerScores.sort((a, b) => b.avgImprovement - a.avgImprovement);

  return {
    essays: essayScores,
    reviewers: reviewerScores,
  };
}

/**
 * Calculate aggregate rankings across all topics for scoring test.
 */
function calculateScoringAggregateRankings(
  topics: TopicResults[]
): ArenaResults["aggregateRankings"] {
  const modelScores: Record<
    string,
    { scores: number[]; improvements: number[] }
  > = {};
  const reviewerImprovements: Record<string, number[]> = {};

  for (const topic of topics) {
    const originalByAuthor: Record<string, number> = {};
    for (const entry of topic.rankings.essays) {
      if (entry.type === "original") {
        originalByAuthor[entry.author] = entry.avgScore;
        if (!modelScores[entry.author]) {
          modelScores[entry.author] = { scores: [], improvements: [] };
        }
        modelScores[entry.author]!.scores.push(entry.avgScore);
      }
    }

    for (const entry of topic.rankings.essays) {
      if (entry.type === "revised" && entry.reviewer) {
        const original = originalByAuthor[entry.author]!;
        const improvement = entry.avgScore - original;
        modelScores[entry.author]!.improvements.push(improvement);

        if (!reviewerImprovements[entry.reviewer]) {
          reviewerImprovements[entry.reviewer] = [];
        }
        reviewerImprovements[entry.reviewer]!.push(improvement);
      }
    }
  }

  const essayRankings = Object.entries(modelScores).map(([author, data]) => ({
    author,
    avgScore: data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
    avgImprovement:
      data.improvements.length > 0
        ? data.improvements.reduce((a, b) => a + b, 0) /
          data.improvements.length
        : 0,
  }));
  essayRankings.sort((a, b) => b.avgScore - a.avgScore);

  const reviewerRankings = Object.entries(reviewerImprovements).map(
    ([reviewer, improvements]) => ({
      reviewer,
      avgImprovement:
        improvements.reduce((a, b) => a + b, 0) / improvements.length,
    })
  );
  reviewerRankings.sort((a, b) => b.avgImprovement - a.avgImprovement);

  return {
    essays: essayRankings,
    reviewers: reviewerRankings,
  };
}

/**
 * Prints topic results for scoring test.
 */
function printScoringTopicResults(result: TopicResults) {
  console.log(`\n  📊 Results for "${result.topic}":\n`);

  console.log("  📝 Essay Rankings (by avg score):");
  result.rankings.essays.slice(0, 5).forEach((entry, index) => {
    const label = entry.reviewer
      ? `${entry.author} ← ${entry.reviewer} (revised)`
      : `${entry.author} (original)`;
    console.log(`    ${index + 1}. ${label} - ${entry.avgScore.toFixed(2)}`);
  });
  if (result.rankings.essays.length > 5) {
    console.log(`    ... and ${result.rankings.essays.length - 5} more`);
  }

  console.log("\n  🎯 Reviewer Rankings (by improvement impact):");
  result.rankings.reviewers.forEach((entry, index) => {
    const sign = entry.avgImprovement >= 0 ? "+" : "";
    console.log(
      `    ${index + 1}. ${
        entry.reviewer
      } - ${sign}${entry.avgImprovement.toFixed(2)}`
    );
  });
}

/**
 * Run all phases for a single topic (scoring test).
 */
async function runScoringTopicArena(
  topic: string,
  topicIndex: number,
  totalTopics: number,
  baseDir: string
): Promise<TopicResults> {
  console.log(
    `\n${"═".repeat(60)}\n📚 Topic ${
      topicIndex + 1
    }/${totalTopics}: "${topic}"\n${"═".repeat(60)}`
  );

  const topicDir = await createTopicDirectories(baseDir, topic);

  console.log("\n  📝 Phase 1: Essay Generation");
  const essays = await runPhase1Essays(topic, topicDir);
  console.log(`  ✓ Phase 1 complete: ${modelsToRun.length} essays`);

  console.log("\n  📋 Phase 2: Feedback Generation");
  const feedback = await runPhase2Feedback(topic, essays, topicDir);
  const feedbackCount = modelsToRun.length * (modelsToRun.length - 1);
  console.log(`  ✓ Phase 2 complete: ${feedbackCount} feedback pieces`);

  console.log("\n  ✏️  Phase 3: Revisions");
  const revisions = await runPhase3Revisions(topic, essays, feedback, topicDir);
  console.log(`  ✓ Phase 3 complete: ${feedbackCount} revisions`);

  console.log("\n  ⭐ Phase 4: Scoring");
  const scores = await runPhase4Scoring(topic, essays, revisions);
  console.log(`  ✓ Phase 4 complete`);

  const rankings = calculateScoringRankings(scores);

  return {
    topic,
    essays,
    feedback,
    revisions,
    scores,
    rankings,
  };
}

/**
 * Formats duration in milliseconds to human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
}

/**
 * Main scoring test orchestration.
 */
async function runScoringTest(): Promise<void> {
  usageTracker = createUsageTracker();

  const confirmed = await confirmScoringRun();
  if (!confirmed) {
    console.log("\nAborted.");
    process.exit(0);
  }

  const overallStart = Date.now();

  const { baseDir, timestamp } = await initArenaRun("scoring-test");
  console.log(`\nResults will be saved to: ${baseDir}`);

  const topicResults: TopicResults[] = [];
  const topicTimes: Array<{ topic: string; duration: number }> = [];

  for (let i = 0; i < TOPICS.length; i++) {
    const topic = TOPICS[i]!;
    const topicStart = Date.now();
    const result = await runScoringTopicArena(topic, i, TOPICS.length, baseDir);
    const topicDuration = Date.now() - topicStart;
    topicResults.push(result);
    topicTimes.push({ topic, duration: topicDuration });
    printScoringTopicResults(result);
    console.log(`\n  ⏱️  Topic completed in ${formatDuration(topicDuration)}`);
  }

  console.log("\n\n📊 Calculating aggregate rankings...\n");

  // Log all topic results before aggregate
  console.log("═".repeat(60));
  console.log("\n📋 INDIVIDUAL TOPIC RESULTS\n");
  for (const result of topicResults) {
    printScoringTopicResults(result);
    console.log("");
  }
  const aggregateRankings = calculateScoringAggregateRankings(topicResults);

  const results: ArenaResults = {
    timestamp,
    models: modelsToRun.map((m) => m.name),
    topics: topicResults,
    aggregateRankings,
  };

  await writeResultsJson(baseDir, results);
  await writeSummary(baseDir, results);

  console.log("═".repeat(60));
  console.log("\n🏆 AGGREGATE RESULTS\n");

  console.log("📝 Models (as Writers):\n");
  aggregateRankings.essays.forEach((entry, index) => {
    const sign = entry.avgImprovement >= 0 ? "+" : "";
    console.log(
      `  ${index + 1}. ${entry.author} - ${entry.avgScore.toFixed(
        2
      )} avg (${sign}${entry.avgImprovement.toFixed(2)} after feedback)`
    );
  });

  console.log("\n🎯 Reviewers (by improvement impact):\n");
  aggregateRankings.reviewers.forEach((entry, index) => {
    const sign = entry.avgImprovement >= 0 ? "+" : "";
    console.log(
      `  ${index + 1}. ${
        entry.reviewer
      } - ${sign}${entry.avgImprovement.toFixed(2)}`
    );
  });

  printUsageSummary("scoring-test");

  const overallDuration = Date.now() - overallStart;
  console.log("\n" + "═".repeat(60));
  console.log("\n⏱️  RUNTIME SUMMARY\n");
  topicTimes.forEach((t) => {
    console.log(
      `  ${t.topic.slice(0, 40).padEnd(42)} ${formatDuration(t.duration)}`
    );
  });
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  ${"Total".padEnd(42)} ${formatDuration(overallDuration)}`);

  console.log(`\n✨ Scoring test complete! Results saved to: ${baseDir}`);
}

// ============================================================================
// 1V1 TEST SPECIFIC
// ============================================================================

/**
 * Counts API calls for 1v1 test.
 */
function countOneVsOneApiCalls() {
  let essays = 0;
  let feedback = 0;
  let revisions = 0;
  let comparisons = 0;

  const n = modelsToRun.length;
  const judgeCount = comparisonJudges.length;

  for (const _topic of TOPICS) {
    // Phase 1: Essays
    essays += n;

    // Phase 2: Feedback (each model reviews every other)
    feedback += n * (n - 1);

    // Phase 3: Revisions (each author revises per reviewer)
    revisions += n * (n - 1);

    // Phase 4: Comparisons
    // Original essays: C(n, 2) pairs = n*(n-1)/2, each judged by n models
    const originalPairs = (n * (n - 1)) / 2;
    comparisons += originalPairs * judgeCount;

    // Revised essays: each model has (n-1) revisions
    // Total revised essays = n * (n-1)
    // Pairs of revised essays = C(n*(n-1), 2) = ...but we only compare within same topic
    // Actually: all revised essays compete pairwise
    const revisedCount = n * (n - 1);
    const revisedPairs = (revisedCount * (revisedCount - 1)) / 2;
    comparisons += revisedPairs * judgeCount;
  }

  return {
    essays,
    feedback,
    revisions,
    comparisons,
    total: essays + feedback + revisions + comparisons,
  };
}

/**
 * Prompts for 1v1 test confirmation.
 */
async function confirmOneVsOneRun(): Promise<boolean> {
  const { essays, feedback, revisions, comparisons, total } =
    countOneVsOneApiCalls();

  console.log("\n🏟️  Writing Quality Arena - 1v1 Test\n");
  if (isDryRun) {
    console.log("⚡ DRY RUN MODE (using cheap models)\n");
  }
  console.log(`Models: ${modelsToRun.length}`);
  console.log(`Comparison judges: ${comparisonJudges.length}`);
  console.log(`Topics: ${TOPICS.length}`);
  console.log(`\nAPI Call Breakdown (across all ${TOPICS.length} topics):`);
  console.log(
    `  Phase 1 - Essays:      ${essays.toString().padStart(6)} calls`
  );
  console.log(
    `  Phase 2 - Feedback:    ${feedback.toString().padStart(6)} calls`
  );
  console.log(
    `  Phase 3 - Revisions:   ${revisions.toString().padStart(6)} calls`
  );
  console.log(
    `  Phase 4 - Comparisons: ${comparisons.toString().padStart(6)} calls`
  );
  console.log(`  ────────────────────────────`);
  console.log(
    `  Total:                 ${total.toString().padStart(6)} calls\n`
  );
  console.log(`Parallelism: ${PARALLEL_LIMIT} concurrent requests\n`);

  process.stdout.write("Proceed? (Y/n): ");

  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      const input = data.toString().trim().toLowerCase();
      resolve(input === "" || input === "y" || input === "yes");
    });
  });
}

/**
 * Phase 4 (1v1): Head-to-head comparisons of all essays.
 */
async function runPhase4Comparisons(
  topic: string,
  essays: Record<string, string>,
  revisions: Record<string, Record<string, string>>,
  topicDir: string
): Promise<ComparisonResult[]> {
  const limit = createApiLimit();
  const comparisons: ComparisonResult[] = [];

  // Build list of all essays (original + revised)
  interface EssayEntry {
    author: string;
    reviewer?: string;
    text: string;
  }

  const allEssays: EssayEntry[] = [];

  // Add original essays
  for (const author of Object.keys(essays)) {
    allEssays.push({ author, text: essays[author]! });
  }

  // Add revised essays
  for (const author of Object.keys(revisions)) {
    for (const reviewer of Object.keys(revisions[author]!)) {
      allEssays.push({
        author,
        reviewer,
        text: revisions[author]![reviewer]!,
      });
    }
  }

  // Generate all unique pairs
  const pairs: Array<[EssayEntry, EssayEntry]> = [];
  for (let i = 0; i < allEssays.length; i++) {
    for (let j = i + 1; j < allEssays.length; j++) {
      pairs.push([allEssays[i]!, allEssays[j]!]);
    }
  }

  const tasks: Array<Promise<void>> = [];

  for (const judge of comparisonJudges) {
    for (const [essayA, essayB] of pairs) {
      tasks.push(
        limit(async () => {
          const labelA = essayA.reviewer
            ? `${essayA.author}←${essayA.reviewer}`
            : essayA.author;
          const labelB = essayB.reviewer
            ? `${essayB.author}←${essayB.reviewer}`
            : essayB.author;

          console.log(`    ${judge.name} comparing ${labelA} vs ${labelB}...`);

          const result = await compareEssays(
            judge,
            { author: essayA.author, text: essayA.text },
            { author: essayB.author, text: essayB.text },
            topic
          );

          if (!result) {
            return;
          }

          const comparison: ComparisonResult = {
            judge: judge.name,
            essayA: { author: essayA.author, reviewer: essayA.reviewer },
            essayB: { author: essayB.author, reviewer: essayB.reviewer },
            winner: result.winner,
            reasoning: result.reasoning,
          };

          comparisons.push(comparison);
          usageTracker.comparisons[judge.name]!.push(result.usage);

          await writeComparison(
            topicDir,
            judge.name,
            { author: essayA.author, reviewer: essayA.reviewer },
            { author: essayB.author, reviewer: essayB.reviewer },
            result.winner,
            result.reasoning
          );

          const winnerLabel =
            result.winner === "A"
              ? labelA
              : result.winner === "B"
              ? labelB
              : "Tie";
          console.log(
            `    ✓ ${judge.name}: ${labelA} vs ${labelB} → ${winnerLabel} (${
              result.usage.totalTokens
            } tokens, $${result.usage.cost.toFixed(4)})`
          );
        })
      );
    }
  }

  await Promise.all(tasks);
  return comparisons;
}

/**
 * Calculate rankings from comparisons for a single topic.
 */
function calculateOneVsOneRankings(
  comparisons: ComparisonResult[]
): OneVsOneTopicResults["rankings"] {
  // Track wins/losses/ties per essay
  const stats: Record<
    string,
    {
      wins: number;
      losses: number;
      ties: number;
      author: string;
      reviewer?: string;
    }
  > = {};

  function getKey(author: string, reviewer?: string) {
    return reviewer ? `${author}:${reviewer}` : author;
  }

  for (const comp of comparisons) {
    const keyA = getKey(comp.essayA.author, comp.essayA.reviewer);
    const keyB = getKey(comp.essayB.author, comp.essayB.reviewer);

    if (!stats[keyA]) {
      stats[keyA] = {
        wins: 0,
        losses: 0,
        ties: 0,
        author: comp.essayA.author,
        reviewer: comp.essayA.reviewer,
      };
    }
    if (!stats[keyB]) {
      stats[keyB] = {
        wins: 0,
        losses: 0,
        ties: 0,
        author: comp.essayB.author,
        reviewer: comp.essayB.reviewer,
      };
    }

    if (comp.winner === "A") {
      stats[keyA]!.wins++;
      stats[keyB]!.losses++;
    } else if (comp.winner === "B") {
      stats[keyB]!.wins++;
      stats[keyA]!.losses++;
    } else {
      stats[keyA]!.ties++;
      stats[keyB]!.ties++;
    }
  }

  const essays = Object.values(stats).map((s) => ({
    author: s.author,
    reviewer: s.reviewer,
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    winRate:
      s.wins + s.losses + s.ties > 0
        ? s.wins / (s.wins + s.losses + s.ties)
        : 0,
  }));

  essays.sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

  return { essays };
}

/**
 * Calculate aggregate rankings across all topics for 1v1 test.
 */
function calculateOneVsOneAggregateRankings(
  topics: OneVsOneTopicResults[]
): OneVsOneResults["aggregateRankings"] {
  // Aggregate by original author only (not per-revision)
  const authorStats: Record<
    string,
    { wins: number; losses: number; ties: number }
  > = {};

  // Aggregate by reviewer (how well essays do after being revised by this reviewer)
  const reviewerStats: Record<
    string,
    { wins: number; losses: number; ties: number }
  > = {};

  // Aggregate by author+reviewer pairing
  const pairingStats: Record<
    string,
    {
      author: string;
      reviewer: string;
      wins: number;
      losses: number;
      ties: number;
    }
  > = {};

  for (const topic of topics) {
    for (const entry of topic.rankings.essays) {
      if (!entry.reviewer) {
        // Original essay - count for author
        if (!authorStats[entry.author]) {
          authorStats[entry.author] = { wins: 0, losses: 0, ties: 0 };
        }
        authorStats[entry.author]!.wins += entry.wins;
        authorStats[entry.author]!.losses += entry.losses;
        authorStats[entry.author]!.ties += entry.ties;
      } else {
        // Revised essay - count for reviewer and pairing
        if (!reviewerStats[entry.reviewer]) {
          reviewerStats[entry.reviewer] = { wins: 0, losses: 0, ties: 0 };
        }
        reviewerStats[entry.reviewer]!.wins += entry.wins;
        reviewerStats[entry.reviewer]!.losses += entry.losses;
        reviewerStats[entry.reviewer]!.ties += entry.ties;

        const pairingKey = `${entry.author}:${entry.reviewer}`;
        if (!pairingStats[pairingKey]) {
          pairingStats[pairingKey] = {
            author: entry.author,
            reviewer: entry.reviewer,
            wins: 0,
            losses: 0,
            ties: 0,
          };
        }
        pairingStats[pairingKey]!.wins += entry.wins;
        pairingStats[pairingKey]!.losses += entry.losses;
        pairingStats[pairingKey]!.ties += entry.ties;
      }
    }
  }

  const calcWinRate = (s: { wins: number; losses: number; ties: number }) =>
    s.wins + s.losses + s.ties > 0 ? s.wins / (s.wins + s.losses + s.ties) : 0;

  const essays = Object.entries(authorStats).map(([author, s]) => ({
    author,
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    winRate: calcWinRate(s),
  }));
  essays.sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

  const reviewers = Object.entries(reviewerStats).map(([reviewer, s]) => ({
    reviewer,
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    winRate: calcWinRate(s),
  }));
  reviewers.sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

  const pairings = Object.values(pairingStats).map((s) => ({
    author: s.author,
    reviewer: s.reviewer,
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    winRate: calcWinRate(s),
  }));
  pairings.sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

  return { essays, reviewers, pairings };
}

/**
 * Prints topic results for 1v1 test.
 */
function printOneVsOneTopicResults(result: OneVsOneTopicResults) {
  console.log(`\n  📊 Results for "${result.topic}":\n`);

  console.log("  📝 Essay Rankings (by win rate):");
  result.rankings.essays.slice(0, 5).forEach((entry, index) => {
    const label = entry.reviewer
      ? `${entry.author} ← ${entry.reviewer} (revised)`
      : `${entry.author} (original)`;
    console.log(
      `    ${index + 1}. ${label} - ${entry.wins}W/${entry.losses}L/${
        entry.ties
      }T (${(entry.winRate * 100).toFixed(1)}%)`
    );
  });
  if (result.rankings.essays.length > 5) {
    console.log(`    ... and ${result.rankings.essays.length - 5} more`);
  }
}

/**
 * Run all phases for a single topic (1v1 test).
 */
async function runOneVsOneTopicArena(
  topic: string,
  topicIndex: number,
  totalTopics: number,
  baseDir: string
): Promise<OneVsOneTopicResults> {
  console.log(
    `\n${"═".repeat(60)}\n📚 Topic ${
      topicIndex + 1
    }/${totalTopics}: "${topic}"\n${"═".repeat(60)}`
  );

  const topicDir = await createTopicDirectories(baseDir, topic);

  console.log("\n  📝 Phase 1: Essay Generation");
  const essays = await runPhase1Essays(topic, topicDir);
  console.log(`  ✓ Phase 1 complete: ${modelsToRun.length} essays`);

  console.log("\n  📋 Phase 2: Feedback Generation");
  const feedback = await runPhase2Feedback(topic, essays, topicDir);
  const feedbackCount = modelsToRun.length * (modelsToRun.length - 1);
  console.log(`  ✓ Phase 2 complete: ${feedbackCount} feedback pieces`);

  console.log("\n  ✏️  Phase 3: Revisions");
  const revisions = await runPhase3Revisions(topic, essays, feedback, topicDir);
  console.log(`  ✓ Phase 3 complete: ${feedbackCount} revisions`);

  console.log("\n  🥊 Phase 4: Head-to-Head Comparisons");
  const comparisons = await runPhase4Comparisons(
    topic,
    essays,
    revisions,
    topicDir
  );
  console.log(`  ✓ Phase 4 complete: ${comparisons.length} comparisons`);

  const rankings = calculateOneVsOneRankings(comparisons);

  return {
    topic,
    essays,
    feedback,
    revisions,
    comparisons,
    rankings,
  };
}

/**
 * Main 1v1 test orchestration.
 */
async function runOneVsOneTest(): Promise<void> {
  usageTracker = createUsageTracker();

  const confirmed = await confirmOneVsOneRun();
  if (!confirmed) {
    console.log("\nAborted.");
    process.exit(0);
  }

  const overallStart = Date.now();

  const { baseDir, timestamp } = await initArenaRun("1v1");
  console.log(`\nResults will be saved to: ${baseDir}`);

  const topicResults: OneVsOneTopicResults[] = [];
  const topicTimes: Array<{ topic: string; duration: number }> = [];

  for (let i = 0; i < TOPICS.length; i++) {
    const topic = TOPICS[i]!;
    const topicStart = Date.now();
    const result = await runOneVsOneTopicArena(
      topic,
      i,
      TOPICS.length,
      baseDir
    );
    const topicDuration = Date.now() - topicStart;
    topicResults.push(result);
    topicTimes.push({ topic, duration: topicDuration });
    printOneVsOneTopicResults(result);
    console.log(`\n  ⏱️  Topic completed in ${formatDuration(topicDuration)}`);
  }

  console.log("\n\n📊 Calculating aggregate rankings...\n");

  // Log all topic results before aggregate
  console.log("═".repeat(60));
  console.log("\n📋 INDIVIDUAL TOPIC RESULTS\n");
  for (const result of topicResults) {
    printOneVsOneTopicResults(result);
    console.log("");
  }

  const aggregateRankings = calculateOneVsOneAggregateRankings(topicResults);

  const results: OneVsOneResults = {
    timestamp,
    models: modelsToRun.map((m) => m.name),
    topics: topicResults,
    aggregateRankings,
  };

  await writeOneVsOneResultsJson(baseDir, results);
  await writeOneVsOneSummary(baseDir, results);

  console.log("═".repeat(60));
  console.log("\n🏆 AGGREGATE RESULTS\n");

  console.log("📝 Models (as Writers - Original Essays):\n");
  aggregateRankings.essays.forEach((entry, index) => {
    console.log(
      `  ${index + 1}. ${entry.author} - ${entry.wins}W/${entry.losses}L/${
        entry.ties
      }T (${(entry.winRate * 100).toFixed(1)}% win rate)`
    );
  });

  console.log("\n🎯 Reviewers (by revised essay performance):\n");
  aggregateRankings.reviewers.forEach((entry, index) => {
    console.log(
      `  ${index + 1}. ${entry.reviewer} - ${entry.wins}W/${entry.losses}L/${
        entry.ties
      }T (${(entry.winRate * 100).toFixed(1)}% win rate)`
    );
  });

  console.log("\n🤝 Pairings (Author + Reviewer):\n");
  aggregateRankings.pairings.forEach((entry, index) => {
    console.log(
      `  ${index + 1}. ${entry.author} ← ${entry.reviewer} - ${entry.wins}W/${
        entry.losses
      }L/${entry.ties}T (${(entry.winRate * 100).toFixed(1)}% win rate)`
    );
  });

  printUsageSummary("1v1");

  const overallDuration = Date.now() - overallStart;
  console.log("\n" + "═".repeat(60));
  console.log("\n⏱️  RUNTIME SUMMARY\n");
  topicTimes.forEach((t) => {
    console.log(
      `  ${t.topic.slice(0, 40).padEnd(42)} ${formatDuration(t.duration)}`
    );
  });
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  ${"Total".padEnd(42)} ${formatDuration(overallDuration)}`);

  console.log(`\n✨ 1v1 test complete! Results saved to: ${baseDir}`);
}

// ============================================================================
// SHARED UTILITIES
// ============================================================================

/**
 * Calculates average tokens from an array of usage records.
 */
function calcAverage(usages: TokenUsage[]) {
  if (usages.length === 0) return { tokens: 0, cost: 0 };
  const totalTokens = usages.reduce((sum, u) => sum + u.totalTokens, 0);
  const totalCost = usages.reduce((sum, u) => sum + u.cost, 0);
  return {
    tokens: Math.round(totalTokens / usages.length),
    cost: totalCost,
  };
}

/**
 * Prints a summary of token usage and costs.
 */
function printUsageSummary(testType: TestType) {
  console.log("\n" + "═".repeat(60));
  console.log("\n💰 TOKEN USAGE & COST SUMMARY\n");

  let totalEssayCost = 0;
  let totalReviewCost = 0;
  let totalRevisionCost = 0;
  let totalScoreCost = 0;
  let totalComparisonCost = 0;

  const modelStats: Array<{
    name: string;
    essayAvgTokens: number;
    essayCost: number;
    reviewAvgTokens: number;
    reviewCost: number;
    revisionAvgTokens: number;
    revisionCost: number;
    scoreCost: number;
    comparisonCost: number;
    totalCost: number;
  }> = [];

  for (const model of modelsToRun) {
    const essayStats = calcAverage(usageTracker.essays[model.name]!);
    const reviewStats = calcAverage(usageTracker.reviews[model.name]!);
    const revisionStats = calcAverage(usageTracker.revisions[model.name]!);
    const scoreStats = calcAverage(usageTracker.scores[model.name]!);
    const comparisonStats = calcAverage(usageTracker.comparisons[model.name]!);

    totalEssayCost += essayStats.cost;
    totalReviewCost += reviewStats.cost;
    totalRevisionCost += revisionStats.cost;
    totalScoreCost += scoreStats.cost;
    totalComparisonCost += comparisonStats.cost;

    modelStats.push({
      name: model.name,
      essayAvgTokens: essayStats.tokens,
      essayCost: essayStats.cost,
      reviewAvgTokens: reviewStats.tokens,
      reviewCost: reviewStats.cost,
      revisionAvgTokens: revisionStats.tokens,
      revisionCost: revisionStats.cost,
      scoreCost: scoreStats.cost,
      comparisonCost: comparisonStats.cost,
      totalCost:
        essayStats.cost +
        reviewStats.cost +
        revisionStats.cost +
        scoreStats.cost +
        comparisonStats.cost,
    });
  }

  const grandTotal =
    totalEssayCost +
    totalReviewCost +
    totalRevisionCost +
    totalScoreCost +
    totalComparisonCost;

  console.log("Phase Costs:");
  console.log(`  Essays (First):     $${totalEssayCost.toFixed(4)}`);
  console.log(`  Reviews:            $${totalReviewCost.toFixed(4)}`);
  console.log(`  Revisions (Follow): $${totalRevisionCost.toFixed(4)}`);
  if (testType === "scoring-test") {
    console.log(`  Scoring:            $${totalScoreCost.toFixed(4)}`);
  } else {
    console.log(`  Comparisons:        $${totalComparisonCost.toFixed(4)}`);
  }
  console.log(`  ────────────────────────────`);
  console.log(`  Total:              $${grandTotal.toFixed(4)}`);

  console.log("\n\nPer-Model Token Averages & Costs:\n");
  console.log(
    "  Model".padEnd(32) +
      "First Essay".padStart(14) +
      "Reviews".padStart(14) +
      "Follow-up".padStart(14) +
      "Total Cost".padStart(12)
  );
  console.log("  " + "─".repeat(84));

  for (const stat of modelStats.sort((a, b) => b.totalCost - a.totalCost)) {
    const essayCol = `${stat.essayAvgTokens} tok`.padStart(14);
    const reviewCol = `${stat.reviewAvgTokens} tok`.padStart(14);
    const revisionCol = `${stat.revisionAvgTokens} tok`.padStart(14);
    const costCol = `$${stat.totalCost.toFixed(4)}`.padStart(12);
    console.log(
      `  ${stat.name.padEnd(30)}${essayCol}${reviewCol}${revisionCol}${costCol}`
    );
  }

  console.log("\n  " + "─".repeat(84));
  console.log(`  ${"GRAND TOTAL".padEnd(72)}$${grandTotal.toFixed(4)}`);
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
  let testType = getTestTypeFromArgs();

  if (!testType) {
    testType = await selectTestType();
  }

  if (testType === "scoring-test") {
    await runScoringTest();
  } else {
    await runOneVsOneTest();
  }
}

main().catch((error) => {
  console.error("Error running arena:", error);
  process.exit(1);
});
