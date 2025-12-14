import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

// Initialize the OpenRouter provider
if (!process.env.OPENROUTER_API_KEY) {
  throw new Error(
    "OPENROUTER_API_KEY environment variable is required. Please set it before running the script."
  );
}

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Parallelism configuration
export const PARALLEL_LIMIT = 100;

/**
 * Stagger request start times to avoid huge bursts when running high concurrency.
 *
 * This is applied per-phase, and bounded by roughly:
 *   (PARALLEL_LIMIT - 1) * API_STAGGER_MS
 *
 * You can override via env vars:
 * - ARENA_API_STAGGER_MS
 * - ARENA_API_STAGGER_JITTER_MS
 */
export const API_STAGGER_MS =
  Number.parseInt(process.env.ARENA_API_STAGGER_MS ?? "", 10) || 25;
export const API_STAGGER_JITTER_MS =
  Number.parseInt(process.env.ARENA_API_STAGGER_JITTER_MS ?? "", 10) || 25;

// Essay topics
export const TOPICS = [
  // "The role of failure in personal growth",
  // "Why boredom is underrated",
  "The ethics of artificial intelligence",
  "How social media reshapes human connection",
  // "The value of slow living in a fast world",
  // "Why we should embrace uncertainty",
  // "The hidden costs of convenience",
  // "What makes a good explanation",
  // "The relationship between creativity and constraint",
  // "Why some ideas spread and others don't",
  "the negative impacts on society from artificial intelligence",
] as const;

// Model definition
export interface RunnableModel {
  name: string;
  llm: LanguageModel;
  reasoning: boolean;
  /** If true, this model will be used as a "reviewer/judge" for comparisons. */
  reviewer: boolean;
}

// Include "usage" so we can log cost
const defaultProviderOptions = {
  usage: {
    include: true,
  },
};

export const modelsToRun: RunnableModel[] = [
  // Anthropic
  {
    name: "claude-4.5-opus-reasoning",
    llm: openrouter("anthropic/claude-opus-4.5", {
      ...defaultProviderOptions,
      reasoning: { effort: "high" },
    }),
    reasoning: true,
    reviewer: true,
  },
  // {
  //   name: "claude-4.5-opus-non-reasoning",
  //   llm: openrouter("anthropic/claude-opus-4.5", defaultProviderOptions),
  //   reasoning: false,
  //   reviewer: true,
  // },

  // OpenAI
  // {
  //   name: "gpt-4o",
  //   llm: openrouter("openai/gpt-4o", defaultProviderOptions),
  //   reasoning: false,
  //   reviewer: true,
  // },
  // {
  //   name: "gpt-5.1",
  //   llm: openrouter("openai/gpt-5.1", {
  //     ...defaultProviderOptions,
  //     reasoning: { effort: "high" },
  //   }),
  //   reasoning: true,
  //   reviewer: false,
  // },
  {
    name: "gpt-5.2",
    llm: openrouter("openai/gpt-5.2", {
      ...defaultProviderOptions,
      reasoning: { effort: "high" },
    }),
    reasoning: true,
    reviewer: true,
  },
  // {
  //   name: "gpt-5.1-chat",
  //   llm: openrouter("openai/gpt-5.1-chat", defaultProviderOptions),
  //   reasoning: false,
  //   reviewer: true,
  // },
  // {
  //   name: "gpt-5-mini",
  //   llm: openrouter("openai/gpt-5-mini", defaultProviderOptions),
  //   reasoning: true,
  //   reviewer: true,
  // },

  // Google
  {
    name: "gemini-3-pro-preview",
    llm: openrouter("google/gemini-3-pro-preview", {
      ...defaultProviderOptions,
      reasoning: { effort: "high" },
    }),
    reasoning: true,
    reviewer: true,
  },
  // {
  //   name: "gemini-2.5-pro",
  //   llm: openrouter("google/gemini-2.5-pro", defaultProviderOptions),
  //   reasoning: true,
  //   reviewer: true,
  // },

  // Grok
  // {
  //   name: "grok-4.1-fast",
  //   llm: openrouter("x-ai/grok-4.1-fast", defaultProviderOptions),
  //   reasoning: true,
  //   reviewer: true,
  // },

  // Open Weight
  // {
  //   name: "kimi-k2",
  //   llm: openrouter("moonshotai/kimi-k2", defaultProviderOptions),
  //   reasoning: false,
  //   reviewer: true,
  // },
  {
    name: "kimi-k2-thinking",
    llm: openrouter("moonshotai/kimi-k2-thinking", {
      ...defaultProviderOptions,
      reasoning: { effort: "high" },
    }),
    reasoning: true,
    reviewer: true,
  },
];

// Cheap models for dry-run testing
export const dryRunModels: RunnableModel[] = [
  {
    name: "claude-4.5-haiku",
    llm: openrouter("anthropic/claude-haiku-4.5", defaultProviderOptions),
    reasoning: false,
    reviewer: true,
  },
  {
    name: "gemini-2.5-flash",
    llm: openrouter("google/gemini-2.5-flash", defaultProviderOptions),
    reasoning: true,
    reviewer: true,
  },
  {
    name: "gpt-5-mini",
    llm: openrouter("openai/gpt-5-mini", defaultProviderOptions),
    reasoning: true,
    reviewer: true,
  },
];
