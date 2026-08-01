Now I'll create a comprehensive implementation plan based on the patterns I've observed across this codebase.

---

# Implementation Plan: Add "documenter" Worker Mode

## 1. Spec-critical details

- **Worker mode name**: `documenter` (lowercase, added to TASK_TYPES)
- **Output file**: `docs/OVERVIEW.md` (must be written in target repository)
- **ECS task family name**: `telos-documenter` (generated from taskType)
- **ECS task CPU**: 1024 (1 vCPU, same tier as reviewer per brief)
- **ECS task memory**: 4096 MB (same tier as reviewer per brief)
- **CloudWatch log group**: `/telos/ecs/documenter`
- **Prompt params**: `DocumenterPromptParams` with required fields `repoFullName: string` and `correlationId: string`
- **Work item type discriminator**: `GENERATE_DOCS`
- **ECS task definition count**: will increase from 6 to 7
- **Task type count in tests**: will increase from 6 to 7

## 2. Ordered steps

### Step 1: Create documenter prompt module
**File**: `packages/core/src/prompts/documenter.ts`

Follow the pattern from `reviewer.ts` and `architect.ts`:
- Export interface `DocumenterPromptParams` with at minimum `repoFullName: string` and `correlationId: string`
- Implement `getDocumenterPrompt(params: DocumenterPromptParams): string`
- Instruct agent to produce/refresh `docs/OVERVIEW.md` in target repo
- Include Role, Allowed Operations, Prohibited Operations, Security Guardrails sections
- Specify output format as JSON with fields like `overviewPath` and `summary`

### Step 2: Update prompts index
**File**: `packages/core/src/prompts/index.ts`

Add two new export lines following the existing pattern:
- `export { getDocumenterPrompt } from './documenter.js';`
- `export type { DocumenterPromptParams } from './documenter.js';`

### Step 3: Create DocumenterWorker class
**File**: `packages/worker/src/workers/documenter-worker.ts`

Follow the structure of `reviewer-worker.ts`:
- Extend `BaseWorker`
- Implement `run(input: Record<string, unknown>, context: WorkerContext): Promise<Record<string, unknown>>`
- Define a result interface (e.g., `DocumenterResult` with `overviewPath` and `summary`)
- Implement input validation (validateInput method) ensuring required fields
- Clone repo (shallow), run Claude Code with getDocumenterPrompt, parse JSON output
- Handle parsing failures gracefully
- Export as `default new DocumenterWorker()`

### Step 4: Wire documenter in entrypoint
**File**: `packages/worker/src/entrypoint.ts`

- Add `'documenter'` to `TASK_TYPES` array (as 7th element)
- Add import: `import { DocumenterWorker } from './workers/documenter-worker.js';`
- Add case in `createWorker()` switch: `case 'documenter': return new DocumenterWorker();`

### Step 5: Add work item type
**File**: `packages/core/src/queue/work-items.ts`

- Create `GenerateDocsSchema` following the pattern of `GenerateArchitectureSchema` and `ReviewPrSchema`
- Schema structure: `WorkItemBaseSchema.extend({ type: z.literal('GENERATE_DOCS') })`
- Add `GenerateDocsSchema` to the discriminated union array in `WorkItemSchema`
- Export type alias: `export type GenerateDocsWorkItem = z.infer<typeof GenerateDocsSchema>;`

### Step 6: Update CDK task definitions
**File**: `packages/cdk/lib/constructs/ecs-task-definitions.ts`

- Update `TaskType` type to include `'documenter'` (becomes union of 7 types)
- Add to `TASK_CONFIGS` array: `{ taskType: 'documenter', cpu: 1024, memoryMiB: 4096 }`
- Placement in array: after 'rebaser' (order doesn't matter functionally, but maintain alphabetic grouping convention)
- No other changes needed — the loop handles task definition, role, and log group creation

### Step 7: Add prompt tests
**File**: `packages/core/__tests__/prompts.test.ts`

Add describe block for `getDocumenterPrompt` following the pattern of other prompts:
- Test returns non-empty string
- Test interpolates required params (repoFullName, correlationId)
- Test includes role definition (contains "document" or similar)
- Test includes output file path (`docs/OVERVIEW.md`)
- Test includes expected output format (JSON with `overviewPath`, `summary`)
- Test includes security guardrails (secret/credential warnings)
- Test includes prohibited operations

### Step 8: Add documenter worker tests
**File**: `packages/worker/__tests__/documenter-worker.test.ts` (new file)

Create a test file following the pattern of `reviewer-worker.test.ts`:
- Mock `node:child_process` and `node:fs/promises`
- Define `makeContext()` and `makeInput()` helpers
- Test validateInput validates all required fields
- Test input validation throws PermanentError for missing/invalid fields
- Test happy path: clones repo, calls Claude Code, returns parsed output
- Test output parsing handles JSON wrapped in markdown fences
- Test handles parsing failure gracefully (defaults to safe response)

### Step 9: Update entrypoint tests
**File**: `packages/worker/__tests__/entrypoint.test.ts`

The existing tests should pass with no modifications IF the routing logic is correct, but verify:
- `createWorker` test iterates all TASK_TYPES and should now test 7 types
- Routing test at line 290–305 should route 'documenter' correctly
- No hardcoded '6' or count assertions to break

### Step 10: Update CDK tests
**File**: `packages/cdk/__tests__/telos-stack.test.ts`

Update two assertions that will become stale:
- Line 286: `it('creates 6 ECS task definitions', ...)` → change to 7
- Line 291–305: `it('creates ECS task definition for each worker type', ...)` → add `'telos-documenter'` to families array
- Line 352–359: `it('creates CloudWatch log groups for all ECS task types', ...)` → add `'documenter'` to taskTypes array

No other assertions should break; the CDK already creates roles dynamically.

## 3. Consistency sweep

- [ ] **Prompts exports**: Both function and type exported from `packages/core/src/prompts/index.ts`
- [ ] **Entrypoint TASK_TYPES array**: 'documenter' added and type now includes 7 variants
- [ ] **Entrypoint createWorker switch**: 'documenter' case routes to new DocumenterWorker instance
- [ ] **Work item discriminated union**: GenerateDocsSchema added and included in WorkItemSchema
- [ ] **Work item type alias**: GenerateDocsWorkItem exported
- [ ] **CDK TaskType union**: Includes 'documenter' (becomes 7-element union)
- [ ] **CDK TASK_CONFIGS**: documenter entry added with 1024/4096 specs
- [ ] **Prompt test suite**: getDocumenterPrompt covered with ≥7 tests
- [ ] **Worker test suite**: DocumenterWorker input validation, happy path, parsing covered
- [ ] **Entrypoint tests**: Still pass with 'documenter' in TASK_TYPES
- [ ] **CDK test counts**: Updated from 6 to 7 for task definitions and log groups
- [ ] **CDK test families list**: Includes 'telos-documenter'
- [ ] **CDK test taskTypes list**: Includes 'documenter'

## 4. Acceptance checklist

Run these commands to verify before declaring complete:

```bash
# Full test suite must be green
pnpm -s test

# Verify prompt is exported correctly
grep -r "getDocumenterPrompt" packages/core/src/prompts/index.ts

# Verify worker is routable
grep -r "documenter" packages/worker/src/entrypoint.ts | grep -E "(TASK_TYPES|createWorker)"

# Verify work item type exists
grep -r "GENERATE_DOCS" packages/core/src/queue/work-items.ts

# Verify CDK includes documenter
grep -r "documenter" packages/cdk/lib/constructs/ecs-task-definitions.ts

# Check no hardcoded '6' remains in CDK tests
grep -n "creates 6 ECS" packages/cdk/__tests__/telos-stack.test.ts && echo "ERROR: stale assertion" || echo "OK: assertion updated"

# Quick smoke: import and instantiate DocumenterWorker
npx tsx -e "import { DocumenterWorker } from './packages/worker/src/workers/documenter-worker.ts'; console.log(new DocumenterWorker() instanceof Object)"
```

---