import pLimit from "p-limit";
import {
  generateEssay,
  reviewEssay,
  reviseEssay,
  scoreEssay,
} from "./aiClient";
import { modelsToRun, PARALLEL_LIMIT, TOPICS } from "./constants";
import {
  createTopicDirectories,
  initArenaRun,
  writeEssay,
  writeFeedback,
  writeResultsJson,
  writeRevision,
  writeSummary,
  type ArenaResults,
  type TopicResults,
} from "./fileUtils";

const limit = pLimit(PARALLEL_LIMIT);

/**
 * Counts the actual API calls for each phase based on model configuration.
 */
function countApiCalls() {
  let essays = 0;
  let feedback = 0;
  let revisions = 0;
  let scores = 0;

  // Per topic counts
  for (const _topic of TOPICS) {
    // Phase 1: Essays
    for (const _model of modelsToRun) {
      essays++;
    }

    // Phase 2: Feedback (each model reviews every OTHER model's essay)
    for (const reviewer of modelsToRun) {
      for (const author of modelsToRun) {
        if (reviewer.name === author.name) continue;
        feedback++;
      }
    }

    // Phase 3: Revisions (each author revises for each reviewer's feedback)
    for (const author of modelsToRun) {
      for (const reviewer of modelsToRun) {
        if (author.name === reviewer.name) continue;
        revisions++;
      }
    }

    // Phase 4: Scoring (every model scores every essay)
    // Original essays
    for (const _judge of modelsToRun) {
      for (const _author of modelsToRun) {
        scores++;
      }
    }
    // Revised essays
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
 * Prompts the user for confirmation before running the arena.
 */
async function confirmRun(): Promise<boolean> {
  const { essays, feedback, revisions, scores, total } = countApiCalls();

  console.log("\n🏟️  Writing Quality Arena\n");
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
 * Phase 1: Each model generates an essay on the topic.
 */
async function runPhase1Essays(
  topic: string,
  topicDir: string
): Promise<Record<string, string>> {
  const essays: Record<string, string> = {};

  const tasks = modelsToRun.map((model) =>
    limit(async () => {
      console.log(`    Generating essay: ${model.name}...`);
      const result = await generateEssay(model, topic);
      essays[model.name] = result.text;
      await writeEssay(topicDir, model.name, result.text);
      console.log(`    ✓ ${model.name}`);
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
  const feedback: Record<string, Record<string, string>> = {};

  // Initialize nested objects
  for (const reviewer of modelsToRun) {
    feedback[reviewer.name] = {};
  }

  const tasks: Array<Promise<void>> = [];

  for (const reviewer of modelsToRun) {
    for (const author of modelsToRun) {
      if (reviewer.name === author.name) continue;

      tasks.push(
        limit(async () => {
          console.log(`    ${reviewer.name} reviewing ${author.name}...`);
          const essayText = essays[author.name]!;
          const result = await reviewEssay(reviewer, essayText, topic);
          feedback[reviewer.name]![author.name] = result.text;
          await writeFeedback(
            topicDir,
            reviewer.name,
            author.name,
            result.text
          );
          console.log(`    ✓ ${reviewer.name} → ${author.name}`);
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
  const revisions: Record<string, Record<string, string>> = {};

  // Initialize nested objects
  for (const author of modelsToRun) {
    revisions[author.name] = {};
  }

  const tasks: Array<Promise<void>> = [];

  for (const author of modelsToRun) {
    for (const reviewer of modelsToRun) {
      if (author.name === reviewer.name) continue;

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
          revisions[author.name]![reviewer.name] = result.text;
          await writeRevision(
            topicDir,
            author.name,
            reviewer.name,
            result.text
          );
          console.log(`    ✓ ${author.name} ← ${reviewer.name}`);
        })
      );
    }
  }

  await Promise.all(tasks);
  return revisions;
}

/**
 * Phase 4: Every model scores every essay (original and revised).
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
  const originalScores: Record<
    string,
    Record<string, { score: number; justification: string }>
  > = {};
  const revisedScores: Record<
    string,
    Record<string, Record<string, { score: number; justification: string }>>
  > = {};

  // Initialize nested objects
  for (const judge of modelsToRun) {
    originalScores[judge.name] = {};
    revisedScores[judge.name] = {};
    for (const author of modelsToRun) {
      revisedScores[judge.name]![author.name] = {};
    }
  }

  const tasks: Array<Promise<void>> = [];

  // Score original essays
  for (const judge of modelsToRun) {
    for (const author of modelsToRun) {
      tasks.push(
        limit(async () => {
          const essayText = essays[author.name]!;
          console.log(`    ${judge.name} scoring ${author.name} (original)...`);
          const result = await scoreEssay(judge, essayText, topic);
          originalScores[judge.name]![author.name] = result;
          console.log(
            `    ✓ ${judge.name} → ${author.name} (original): ${result.score}`
          );
        })
      );
    }
  }

  // Score revised essays
  for (const judge of modelsToRun) {
    for (const author of modelsToRun) {
      for (const reviewer of modelsToRun) {
        if (author.name === reviewer.name) continue;

        tasks.push(
          limit(async () => {
            const revision = revisions[author.name]![reviewer.name]!;
            console.log(
              `    ${judge.name} scoring ${author.name}←${reviewer.name} (revised)...`
            );
            const result = await scoreEssay(judge, revision, topic);
            revisedScores[judge.name]![author.name]![reviewer.name] = result;
            console.log(
              `    ✓ ${judge.name} → ${author.name}←${reviewer.name}: ${result.score}`
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
function calculateRankings(scores: {
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
  const firstJudge = judges[0]!;
  const authors = Object.keys(scores.original[firstJudge]!);

  // Calculate average scores for original essays
  for (const author of authors) {
    const judgeScores = judges.map((j) => scores.original[j]![author]!.score);
    const avgScore =
      judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length;
    essayScores.push({ type: "original", author, avgScore });
  }

  // Calculate average scores for revised essays
  for (const author of authors) {
    for (const reviewer of authors) {
      if (author === reviewer) continue;
      const judgeScores = judges.map(
        (j) => scores.revised[j]![author]![reviewer]!.score
      );
      const avgScore =
        judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length;
      essayScores.push({ type: "revised", author, reviewer, avgScore });
    }
  }

  // Sort by average score descending
  essayScores.sort((a, b) => b.avgScore - a.avgScore);

  // Calculate reviewer impact (average improvement from their feedback)
  const reviewerImpact: Record<string, number[]> = {};
  for (const reviewer of authors) {
    reviewerImpact[reviewer] = [];
  }

  for (const author of authors) {
    const originalAvg =
      judges.reduce((sum, j) => sum + scores.original[j]![author]!.score, 0) /
      judges.length;

    for (const reviewer of authors) {
      if (author === reviewer) continue;
      const revisedAvg =
        judges.reduce(
          (sum, j) => sum + scores.revised[j]![author]![reviewer]!.score,
          0
        ) / judges.length;
      const improvement = revisedAvg - originalAvg;
      reviewerImpact[reviewer]!.push(improvement);
    }
  }

  const reviewerScores = Object.entries(reviewerImpact).map(
    ([reviewer, improvements]) => ({
      reviewer,
      avgImprovement:
        improvements.reduce((a, b) => a + b, 0) / improvements.length,
    })
  );

  // Sort by average improvement descending
  reviewerScores.sort((a, b) => b.avgImprovement - a.avgImprovement);

  return {
    essays: essayScores,
    reviewers: reviewerScores,
  };
}

/**
 * Calculate aggregate rankings across all topics.
 */
function calculateAggregateRankings(
  topics: TopicResults[]
): ArenaResults["aggregateRankings"] {
  // Aggregate scores per model (as writer)
  const modelScores: Record<
    string,
    { scores: number[]; improvements: number[] }
  > = {};
  // Aggregate improvements per reviewer
  const reviewerImprovements: Record<string, number[]> = {};

  for (const topic of topics) {
    // Get original essay scores per author
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

    // Calculate improvement for revised essays
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

  // Calculate averages for essays
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

  // Calculate averages for reviewers
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
 * Run all phases for a single topic.
 */
async function runTopicArena(
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

  // Phase 1: Generate essays
  console.log("\n  📝 Phase 1: Essay Generation");
  const essays = await runPhase1Essays(topic, topicDir);
  console.log(`  ✓ Phase 1 complete: ${modelsToRun.length} essays`);

  // Phase 2: Generate feedback
  console.log("\n  📋 Phase 2: Feedback Generation");
  const feedback = await runPhase2Feedback(topic, essays, topicDir);
  const feedbackCount = modelsToRun.length * (modelsToRun.length - 1);
  console.log(`  ✓ Phase 2 complete: ${feedbackCount} feedback pieces`);

  // Phase 3: Generate revisions
  console.log("\n  ✏️  Phase 3: Revisions");
  const revisions = await runPhase3Revisions(topic, essays, feedback, topicDir);
  console.log(`  ✓ Phase 3 complete: ${feedbackCount} revisions`);

  // Phase 4: Score all essays
  console.log("\n  ⭐ Phase 4: Scoring");
  const scores = await runPhase4Scoring(topic, essays, revisions);
  console.log(`  ✓ Phase 4 complete`);

  // Calculate rankings for this topic
  const rankings = calculateRankings(scores);

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
 * Main arena orchestration.
 */
async function runArena(): Promise<void> {
  const confirmed = await confirmRun();
  if (!confirmed) {
    console.log("\nAborted.");
    process.exit(0);
  }

  const { baseDir, timestamp } = await initArenaRun();
  console.log(`\nResults will be saved to: ${baseDir}`);

  // Run arena for each topic
  const topicResults: TopicResults[] = [];

  for (let i = 0; i < TOPICS.length; i++) {
    const topic = TOPICS[i]!;
    const result = await runTopicArena(topic, i, TOPICS.length, baseDir);
    topicResults.push(result);
  }

  // Calculate aggregate rankings
  console.log("\n\n📊 Calculating aggregate rankings...\n");
  const aggregateRankings = calculateAggregateRankings(topicResults);

  // Compile results
  const results: ArenaResults = {
    timestamp,
    models: modelsToRun.map((m) => m.name),
    topics: topicResults,
    aggregateRankings,
  };

  // Write final results
  await writeResultsJson(baseDir, results);
  await writeSummary(baseDir, results);

  // Print summary
  console.log("═".repeat(60));
  console.log("\n🏆 AGGREGATE RESULTS\n");

  console.log("Top 5 Models (as Writers):\n");
  aggregateRankings.essays.slice(0, 5).forEach((entry, index) => {
    const sign = entry.avgImprovement >= 0 ? "+" : "";
    console.log(
      `  ${index + 1}. ${entry.author} - ${entry.avgScore.toFixed(
        2
      )} avg (${sign}${entry.avgImprovement.toFixed(2)} after feedback)`
    );
  });

  console.log("\n🎯 Top 5 Reviewers (by improvement impact):\n");
  aggregateRankings.reviewers.slice(0, 5).forEach((entry, index) => {
    const sign = entry.avgImprovement >= 0 ? "+" : "";
    console.log(
      `  ${index + 1}. ${
        entry.reviewer
      } - ${sign}${entry.avgImprovement.toFixed(2)}`
    );
  });

  console.log(`\n✨ Arena complete! Results saved to: ${baseDir}`);
}

// Run the arena
runArena().catch((error) => {
  console.error("Error running arena:", error);
  process.exit(1);
});
