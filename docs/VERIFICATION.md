# Verification

Run the complete local matrix on macOS with Node.js 24.14 or newer, installed Chromium/Firefox engines and a working LibreOffice path for the DOCX cases:

```sh
npm ci --ignore-scripts
npm run browser:install
npm run check
```

`npm test` exercises the actual Node services with disposable local stores. `npm run build` creates the production UI. `npm run test:e2e` drives that built UI through Chromium and Firefox. The checked-in GitHub Actions workflow runs the same service and browser coverage on macOS, with serial service fixtures to avoid overlapping cold document-renderer starts.

## What the tests establish

- Discovery identity, public-board coverage, ambiguous location and metadata-only handling, stable favorites, paging and bounded refresh-change receipts.
- Original document retention, structured DOCX/PDF checks, source-bound packages, current candidate/source review gates and exact-document previews.
- Duplicate admission and dispatch guards, supported form controls, consent, eligibility questions and explicit manual/uncertain outcomes.
- Atomic replacement publication and employer-answer settlement under injected storage failures; competing selections, invalid/stale answers and graceful close retain ownership.
- Failed/lost responses, stale workspace reads, real/fixture isolation, draft continuity, keyboard/focus return, enlarged text and phone layouts.
- Native launcher ownership, readiness, backup/restore boundaries and application-bundle content checks.

New atomicity regressions use the real API and rendering services. They fail against the preceding implementation and pass with the repair. Browser tests also check that rendered PDFs cannot overlap following controls and that partial or failed board checks cannot invent removed roles.

Tests use synthetic candidates, local employer fixtures and controlled adapters. Some fixture tests explicitly enable a synthetic campaign to exercise the dispatch state machine. That does not enable or submit a real campaign. Upstream research tests were read, not executed as Hub verification.

## Practical limits

These checks do not certify all employer customizations, live hiring outcomes, universal model accuracy, power-loss atomicity across the filesystem or compatibility with untested operating systems. A particular live portal needs a separately authorized bounded acceptance run. Preparation, a UI indication and a synthetic receipt remain distinct from independently matching employer evidence.

See [the tour](DEMO.md) for a safe first-use walkthrough, [operations](OPERATIONS.md) for recovery and [architecture](ARCHITECTURE.md) for the owning services.
