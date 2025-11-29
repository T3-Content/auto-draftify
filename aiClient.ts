import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { RunnableModel } from "./constants";

export interface EssayResult {
  text: string;
}

export interface ReviewResult {
  text: string;
}

export interface RevisionResult {
  text: string;
}

export const ScoreSchema = z.object({
  score: z.number().min(1).max(10),
  justification: z.string(),
});

export type ScoreResult = z.infer<typeof ScoreSchema>;

/**
 * Generates an essay based on the given topic prompt.
 */
export async function generateEssay(
  model: RunnableModel,
  topic: string
): Promise<EssayResult> {
  const result = await generateText({
    model: model.llm,
    system: `You are an expert essay writer. Write a well-structured, thoughtful essay on the given topic. 
The essay should be clear, engaging, and demonstrate strong writing skills.
Write approximately 800-1200 words.`,
    prompt: `Write an essay on the following topic:\n\n${topic}`,
  });

  return {
    text: result.text,
  };
}

/**
 * Reviews an essay and provides constructive feedback.
 */
export async function reviewEssay(
  model: RunnableModel,
  essay: string,
  topic: string
): Promise<ReviewResult> {
  const result = await generateText({
    model: model.llm,
    system: `You are an expert writing tutor and editor. Review the essay provided and give constructive, 
specific feedback on areas such as structure, clarity, argumentation, style, and areas for improvement. 
Be thorough but encouraging. Focus on actionable improvements.`,
    prompt: `Topic: ${topic}\n\nPlease review the following essay and provide detailed feedback:\n\n${essay}`,
  });

  return {
    text: result.text,
  };
}

/**
 * Revises an essay based on the original topic, original essay, and review feedback.
 */
export async function reviseEssay(
  model: RunnableModel,
  topic: string,
  originalEssay: string,
  feedback: string
): Promise<RevisionResult> {
  const result = await generateText({
    model: model.llm,
    system: `You are an expert essay writer. Revise the provided essay based on the feedback given, 
while maintaining the core message and improving the areas identified. 
Produce a complete revised essay, not just suggestions.`,
    prompt: `Original topic: ${topic}\n\nOriginal essay:\n${originalEssay}\n\nReview feedback:\n${feedback}\n\nPlease revise the essay based on the feedback above.`,
  });

  return {
    text: result.text,
  };
}

/**
 * Scores an essay on a scale of 1-10 with justification.
 */
export async function scoreEssay(
  model: RunnableModel,
  essay: string,
  topic: string
): Promise<ScoreResult> {
  const result = await generateObject({
    model: model.llm,
    schema: ScoreSchema,
    system: `You are an expert essay judge. Score the essay on a scale of 1-10 based on:
- Clarity and coherence of argument
- Quality of writing (style, grammar, flow)
- Depth of insight and originality
- Relevance to the topic
- Overall effectiveness

Be fair and consistent in your scoring. A score of 5 is average, 7-8 is good, 9-10 is exceptional.`,
    prompt: `Topic: ${topic}\n\nPlease score the following essay:\n\n${essay}`,
  });

  return result.object;
}
