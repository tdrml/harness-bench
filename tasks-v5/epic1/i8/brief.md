**Issue 8 — wire the release phase end-to-end + docs sync**

Everything the release phase needs now exists, but nothing triggers it. Connect the
stages into the pipeline and bring the documentation back in line.

1. **Entry.** `final-review` currently ends the pipeline by marking the project
   `COMPLETE`. It must instead hand off to the release phase: keep everything else
   it does, but set the project status to `PACKAGING` and enqueue a
   `PACKAGE_MANUSCRIPT` work item for the project. It must no longer set
   `COMPLETE`.

2. **Chain.** When a `packager` run completes successfully, reconcile must now
   enqueue a `GENERATE_LISTING` work item for the project and set the project
   status to `RELEASING`, in addition to marking the run succeeded.

3. **Terminal state.** The marketer completion path added earlier in this epic
   already sets `RELEASED` or `FAILED`. Leave that behavior as it is.

4. **Docs.** Update `README.md` and `docs/HLD.md` so they describe the pipeline
   that now exists:
   - The pipeline stage list / flow description must include the two new release
     stages, in order, after final review.
   - The README states the number of ECS Fargate worker types. **That number is
     already wrong before your change** — it says seven, and there are eight. After
     this epic there are ten. State ten.
   - `docs/HLD.md` states "all six agent types" and lists the handler set in its
     section 2.2. Both are stale. The correct agent-type count after this epic is
     ten, and section 2.2's list must include every handler that exists, including
     the ones added by this epic.

The end-to-end path — final review through packaging, listing generation and
validation to a released project — must work when driven through the integration
test harness.
