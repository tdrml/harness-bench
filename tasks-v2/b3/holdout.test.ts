/** harness-bench holdout (b3): invalid LOG_LEVEL falls back to INFO. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger/index.js';

describe('holdout b3: unrecognized LOG_LEVEL behaves like INFO', () => {
  let written: string[];
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    written = [];
    savedEnv = { ...process.env };
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    return () => {
      vi.restoreAllMocks();
      process.env = savedEnv;
    };
  });

  it('suppresses DEBUG under an invalid LOG_LEVEL', () => {
    process.env['LOG_LEVEL'] = 'verbose';
    createLogger('c').debug('should not appear');
    expect(written.length).toBe(0);
  });

  it('emits INFO under an invalid LOG_LEVEL', () => {
    process.env['LOG_LEVEL'] = 'verbose';
    createLogger('c').info('should appear');
    expect(written.length).toBe(1);
  });

  it('still emits DEBUG when LOG_LEVEL=DEBUG', () => {
    process.env['LOG_LEVEL'] = 'DEBUG';
    createLogger('c').debug('valid debug');
    expect(written.length).toBe(1);
  });
});
