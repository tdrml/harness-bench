/**
 * harness-bench pilot 7 holdout - epic1 / i2: PACKAGE_MANUSCRIPT work item.
 *
 * Half of this file is graded by the COMPILER, not by vitest: the type-only
 * imports and the union-membership assertions below have no runtime footprint.
 * That is deliberate - `queue/index.ts` is an explicit named-export list and the
 * repo already ships a live omission there (ContinuityFixSchema/Item), so a
 * type that never reaches the barrel is exactly the failure this grades.
 */
import { describe, expect, it } from 'vitest';
import { PackageManuscriptSchema, WorkItemSchema } from '../../index.js';
import type { PackageManuscriptItem, WorkerType, ProjectStatus } from '../../index.js';

// Compile-time only: these fail `tsc --build`, never vitest.
const packagerWorker: WorkerType = 'packager';
const packagingStatus: ProjectStatus = 'PACKAGING';

describe('holdout i2: PACKAGE_MANUSCRIPT schema', () => {
  it('is re-exported from the package barrel', () => {
    expect(PackageManuscriptSchema).toBeDefined();
  });

  it('accepts a minimal valid item', () => {
    const parsed = PackageManuscriptSchema.safeParse({
      type: 'PACKAGE_MANUSCRIPT',
      projectId: 'proj-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional runId', () => {
    const parsed = PackageManuscriptSchema.safeParse({
      type: 'PACKAGE_MANUSCRIPT',
      projectId: 'proj-1',
      runId: 'run-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing projectId', () => {
    expect(PackageManuscriptSchema.safeParse({ type: 'PACKAGE_MANUSCRIPT' }).success).toBe(false);
  });

  it('rejects an empty projectId', () => {
    expect(
      PackageManuscriptSchema.safeParse({ type: 'PACKAGE_MANUSCRIPT', projectId: '' }).success,
    ).toBe(false);
  });
});

describe('holdout i2: work-item union membership', () => {
  it('parses a PACKAGE_MANUSCRIPT message off the queue', () => {
    const parsed = WorkItemSchema.safeParse({
      type: 'PACKAGE_MANUSCRIPT',
      projectId: 'proj-1',
      runId: 'run-1',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('PACKAGE_MANUSCRIPT');
    }
  });

  it('rejects a malformed PACKAGE_MANUSCRIPT message through the union', () => {
    expect(WorkItemSchema.safeParse({ type: 'PACKAGE_MANUSCRIPT' }).success).toBe(false);
  });

  it('narrows to the exported item type', () => {
    const item: PackageManuscriptItem = {
      type: 'PACKAGE_MANUSCRIPT',
      projectId: 'proj-1',
    };
    expect(item.projectId).toBe('proj-1');
    expect(packagerWorker).toBe('packager');
    expect(packagingStatus).toBe('PACKAGING');
  });
});
