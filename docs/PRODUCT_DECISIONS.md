# Product decisions, November 2026

Automation Hub remains a local, single-person workbench with a persistent SQLite ledger, deterministic browser adapters, explicit campaign authority and exact retained documents. Broad ecosystem research did not justify another executor, scheduler, browser cloud or model provider. Existing n8n workflows keep execution and schedule ownership.

## What changed

The light porcelain/ink interface uses a restrained cobalt action color, native system typography, a state-aware Home and an interactive application path. Direct workspace destinations reduce navigation. Global search finds retained applications and questions by their actual context; keyboard selection opens the exact record with purposeful focus. Search is navigation only. Offline state closes it, and existing edit dialogs retain their keyboard ownership. Needs You adds a saved-question index without changing answer/review authority.

Read-only discovery now includes explicitly selected Ashby boards through the [official public Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api). Unlisted rows are excluded; mixed and absent geography remain uncertain; hybrid is distinct from remote; last publication is not presented as the original posting date. Failed or stale checks preserve observations and require a fresh check before local queue selection. Ashby application completion remains manual. Its hosted job and application URLs share one local queue identity, including retained manual history.

Supported portal identities now agree between import and browser execution. Older differently keyed aliases stay immutable and reserve the same underlying requisition. Duplicate checks run before filling and inside the immediate dispatch transaction. Lever US and EU remain distinct. Ashby job/application aliases also share one local queue identity while submission remains unsupported. These are regression-tested properties, not universal employer guarantees.

## Research behind the choices

- [Simplify](https://help.simplify.jobs/en/help/articles/1784339-get-started-with-autopilot), [Jobright](https://jobright.ai/tools/ai-job-apply) and [Huntr packets](https://help.huntr.co/en/articles/14367332-application-hub-and-packets) informed job-first progression, a clear authority boundary and exact per-role material context. Their product descriptions do not establish measured hiring outcomes.
- [Trigger.dev idempotency](https://trigger.dev/docs/idempotency) and [DBOS workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) reinforce stable operation identity and retained results. Internal workflow deduplication alone cannot prove an external submission happened once.
- [Stagehand’s submission guard](https://github.com/browserbase/stagehand/blob/6f2686d792b7f5836b04754e0f6a44db39928592/packages/examples/cookbooks/approve-form-submission/typescript/src/approval.ts), [Skyvern’s effect approvals](https://github.com/Skyvern-AI/skyvern/blob/716b256437bce90b3c83c52a8a401dff6779b33e/skyvern/forge/sdk/browser_effect_approval.py) and [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) informed one-shot authority, current-context binding and the danger of replaying code around a pause. Hub keeps its durable pre-dispatch ledger and uncertain-result reconciliation.
- [Activepieces batch guidance](https://www.activepieces.com/docs/flows/process-in-batches) warns that retrying a batch may replay earlier writes. Hub isolates applications and never treats an uncertain dispatch as an ordinary retry.

Selected source inspections also covered Windmill, browser-use and JobSpy. No upstream implementation or runtime was copied into production. Existing notices and licenses remain intact. The visual critique method included [unslop by Damir Sokolovsky](https://heydamir.design/unslop), CC-BY-4.0; the interface is implemented in the existing React/CSS stack.

## Verification and limits

Repository checks exercise real production services and local browser workflows using isolated synthetic candidates, feeds, employer forms and receipts. They cover original-document retention, supported form paths, eligibility holds, scoped reviews, stale workspace/answer protection, aliases, uncertain dispatch, restart, manual ownership and responsive keyboard navigation. They do not establish live employer acceptance, universal portal coverage or market superiority.

Before a real pilot, import the actual finished résumé corpus and selected roles, validate their templates and portals, confirm facts/rules/required connections and explicitly enable a bounded campaign. A click, saved role or prepared résumé is not a confirmed submission. Only matching employer evidence establishes that result.

The native shell uses the same light appearance and a cobalt/white icon. It still binds only to loopback and retains the existing private worker controls. The palette does not change permissions, execution or evidence rules.
