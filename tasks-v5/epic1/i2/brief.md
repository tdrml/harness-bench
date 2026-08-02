**Issue 2 — `PACKAGE_MANUSCRIPT` work item + `packager` worker type**

The release phase needs its first pipeline stage. This issue adds the queue and
type-level plumbing only; the handler comes later.

1. Add a new work item type `PACKAGE_MANUSCRIPT` to the queue schemas, following
   exactly the shape and conventions of the existing single-project work items
   (compare `FINAL_REVIEW` and `CONTINUITY_AUDIT`):
   - `type`: literal `'PACKAGE_MANUSCRIPT'`
   - `projectId`: required, non-empty string
   - `runId`: optional string
2. It must be part of the discriminated union that validates inbound queue
   messages, so that a valid `PACKAGE_MANUSCRIPT` message parses and one missing
   `projectId` is rejected.
3. Export the new schema and its inferred item type the same way every sibling
   work item is exported, so that both are reachable from `@auto-graph/core`.
   The inferred type must be named `PackageManuscriptItem`.
4. Add `'packager'` to the `WorkerType` union in the DynamoDB types.
5. Add `'PACKAGING'` to the `ProjectStatus` union in the DynamoDB types.

No handler, no worker module, no CDK changes in this issue.
