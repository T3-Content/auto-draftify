# Writing Quality Arena

## Models Configuration

Use the provided `modelsToRun` array in `constants.ts`:

```ts
export type RunnableModel = {
  name: string;
  llm: LanguageModelV1;
  reasoning: boolean;
};

export const modelsToRun: RunnableModel[] = [
  {
    name: "claude-4.5-opus-reasoning",
    llm: openrouter("anthropic/claude-opus-4.5"),
    reasoning: true,
  },
  // ... 11 models total
];

export const PARALLEL_LIMIT = 5; // Configurable concurrency
```

## Execution Flow (4 Phases)

### Phase 1: Essay Generation

Each model writes an essay on the topic. **N calls**.

### Phase 2: All-to-All Review

Every model reviews EVERY essay (including their own). **N × N calls**.

### Phase 3: Per-Reviewer Revisions

Each model creates a separate revised essay for EACH piece of feedback received. **N × N revisions**.

### Phase 4: Scoring

Every model scores EVERY essay (N originals + N×(N-1) revisions). Use `generateObject` with Zod schema:

```ts
const ScoreSchema = z.object({
  score: z.number().min(1).max(10),
  justification: z.string(),
});
```

**N × (N + N×(N-1)) = N × N² = N³ calls**.

## API Call Summary (N=11 models)

| Phase | Formula | Calls |

|-------|---------|-------|

| Essays | N | 11 |

| Feedback | N×(N-1) | 110 |

| Revisions | N×(N-1) | 110 |

| Scores | N³ | 1331 |

| **Total** | | **1562** |

## Rankings

**Essay Ranking**: All essays (original + revised) ranked by average score across all judges.

**Reviewer Ranking**: For each reviewer, calculate avg improvement = mean(revision_score - original_score) for all revisions that used their feedback.

## File Structure

```
results/{timestamp}/
├── essays/{model-name}.md
├── feedback/{reviewer}-on-{author}.md
├── revisions/{author}-revised-by-{reviewer}.md
├── results.json
└── summary.md
```

## File Changes

| File | Change |

|------|--------|

| `constants.ts` | Add `RunnableModel` type, `modelsToRun` array, `PARALLEL_LIMIT` |

| `types.ts` | Already has appropriate types; verify alignment |

| `aiClient.ts` | Update functions to accept `RunnableModel`, add `scoreEssay()` using `generateObject` |

| `index.ts` | Rewrite with 4-phase arena orchestration, parallel execution via `p-limit`, `confirmRun()` |

| `fileUtils.ts` | Rewrite for arena folder structure (`results/` dir, essays/, feedback/, revisions/, results.json, summary.md) |

## CLI Confirmation

Display call counts and prompt before running:

```ts
async function confirmRun(): Promise<boolean> {
  const n = modelsToRun.length;
  const essays = n;
  const feedback = n * (n - 1);
  const revisions = n * (n - 1);
  const scores = n * n * n;
  const total = essays + feedback + revisions + scores;
  // ... display and prompt Y/n
}
```
