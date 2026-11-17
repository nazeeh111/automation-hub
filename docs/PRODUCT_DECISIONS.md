# Product decisions

Automation Hub is a local, single-person workbench for US internships. The product's organizing object is an application with its employer source, candidate facts, exact materials and matching evidence. New features must strengthen that connection or remove a demonstrated obstacle.

## A working desk, not a dashboard of totals

The interface uses a quiet shared frame and an inset white working sheet. IBM Plex Sans is served locally under the SIL Open Font License. A labelled sidebar keeps destinations visible on desktop; a keyboard-contained menu exposes the same destinations on smaller screens. Neutral selection and dark primary actions leave semantic colour for actual holds, evidence and the teal product mark.

Home puts saved questions and useful next actions first, with campaign state beside them. Its workflow explanation is optional. Discovery uses compact employer rows, keeps freshness beside the result count and reveals secondary filters on request. The selected-role pane explains the application route before preparation, including Ashby's manual completion boundary.

Needs You presents one exact question at a time. Current forms remain mounted and hidden/inert, preserving scoped answer and File state. A selected document review loads its actual retained PDF immediately. Approval belongs to that version and role. Application detail uses the full sheet, keeps source and document controls close to the material, and returns to the saved queue intent and focus. Narrow layouts retain visible return actions and keyboard focus after menu navigation. Enlarged text is checked through actual browser geometry.

These are product decisions, not a claim of owner visual acceptance or a numerical design multiplier. The [tour](DEMO.md) uses curated synthetic captures and distinguishes them from the first-use seed.

## Automation remains bounded

Discovery is manually requested public-board reading. It does not own campaign dispatch or n8n schedules. Saving bookmarks a role; queuing explicitly selects it for preparation; a confirmed outcome requires matching employer evidence. Ambiguous geography, unavailable descriptions and missing dates remain uncertain.

Each successful source refresh produces a bounded local change receipt. The first observation is a baseline. Later receipts distinguish newly found, changed and seen-again roles. Only complete coverage can report a newly absent role, and absence is not a claim that the employer closed it. Failed checks retain the earlier successful receipt and its time. Favorites, timestamps and queue state do not invent posting changes.

Portal-family support is separate from form inspection, candidate eligibility and campaign authority. Public Ashby discovery does not imply application submission support. Unknown employer controls, consent, sensitive conditions, anti-automation rules and uncertain external outcomes remain explicit review or manual work.

## Preserve the last working result

Document rendering and verification happen before selection publication. Publication of the exact package, source observation, active selection and review changes uses one synchronous SQLite transaction. A failed replacement cannot displace an approved packet. Unpublished artifact files can remain retained after a rejected publication; they are not active packages or approval authority.

Ordinary question settlement similarly commits its answer, application state, question closure and history together. Non-open questions reject; resolved duplicate answers remain idempotent. Candidate, posting, source corpus and exact-question bindings prevent an old answer or late result from reopening terminal/manual work. Unknown external effects require reconciliation before another attempt.

Employer source observations remain immutable and bounded. A package binds to its source observation, posting hash and candidate revision. Changed or missing bindings hold use of the earlier package while preserving it for comparison. History is loaded per application rather than copied into every dashboard response.

## Research selected patterns, not another runtime

Source inspection of [OpenHands capability assessment](https://github.com/OpenHands/OpenHands/blob/5ed4ffa5ac2509e479acc12b83247fbb4c3612c8/src/manifests/manifest-capabilities.ts) reinforced operation-specific explanations rather than a universal connected badge. [Mastra's competing-resume tests](https://github.com/mastra-ai/mastra/blob/de5af00226ef691c459a79e93cb4137fd14622c9/packages/core/src/agent/__tests__/concurrent-resume-claim.test.ts) informed competing-answer, invalid-input and interrupted-work probes. [Khoj's automation implementation](https://github.com/khoj-ai/khoj/blob/ae229ca894c0b80ad84664afcfdde523b5e87057/src/khoj/routers/api_automation.py) reinforced the distinction between local installation, optional service dependencies and a completed run.

Further inspected sources include Sim, Composio, Inngest and job-application agents, alongside earlier local-assistant/browser-workflow research. Selected source files and upstream tests were read; upstream runtimes/tests were not executed or incorporated. The refresh receipt is a Hub design inference, not a copied upstream feature. No new executor, model provider, browser cloud, general-purpose Jarvis runtime or scheduler was justified. Existing n8n retains its execution and schedule ownership.

## Evidence and limits

Tests exercise real local services and UI with disposable data, injected transport/storage failures and controlled adapters. They cover source drift, competing changes, rollback, stale responses, duplicate prevention and uncertain outcomes. A build, fixture receipt or passing test is not evidence that a particular live employer accepts automation. See [verification](VERIFICATION.md), [architecture](ARCHITECTURE.md) and [operation and recovery](OPERATIONS.md) for reproducible scope and supported procedures.
