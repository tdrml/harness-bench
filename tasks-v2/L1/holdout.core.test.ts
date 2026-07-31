/** harness-bench holdout (L1/core): documenter prompt + GENERATE_DOCS schema. */
import { describe, expect, it } from 'vitest';
import { WorkItemSchema } from '../src/queue/index.js';

describe('holdout L1: documenter core surface', () => {
  it('prompts index exports getDocumenterPrompt producing an OVERVIEW-targeting prompt', async () => {
    const mod = (await import('../src/prompts/index.js')) as Record<string, unknown>;
    expect(typeof mod['getDocumenterPrompt']).toBe('function');
    const fn = mod['getDocumenterPrompt'] as (p: { repoFullName: string; correlationId: string }) => string;
    const prompt = fn({ repoFullName: 'acme/app', correlationId: 'corr-1' });
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('docs/OVERVIEW.md');
  });

  it('WorkItemSchema accepts GENERATE_DOCS with base fields', () => {
    expect(() =>
      WorkItemSchema.parse({
        type: 'GENERATE_DOCS',
        projectId: 'proj-1',
        repoFullName: 'acme/app',
        correlationId: 'corr-1',
      }),
    ).not.toThrow();
  });

  it('WorkItemSchema still rejects unknown types', () => {
    expect(() =>
      WorkItemSchema.parse({
        type: 'NOT_A_TYPE',
        projectId: 'p',
        repoFullName: 'a/b',
        correlationId: 'c',
      }),
    ).toThrow();
  });
});
