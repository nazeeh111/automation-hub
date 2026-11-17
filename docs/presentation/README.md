# Same PDF. New posting. Fresh review.

This is a recorded execution of current Automation Hub, using Alex Example and a fictional local employer adapter in an owned temporary workspace. It is not a live employer application. Native export `mode: live` names the ordinary application workspace type; every person, role, document and observation here was seeded synthetic data. The built-in fixture seed is a separate first-use route, described in the repository tour.

The [case record](case.json) and unmodified [native ledger export](ledger-export.json) retain two posting observations, two packages and the exact old-review refusal. [Finished PDF](finished.pdf) and [downloaded prepared PDF](prepared.pdf) have identical SHA-256 bytes, also shared by the earlier package. The original source text is [candidate.md](candidate.md); the actual app rendered it once before importing that PDF as a finished original.

1. Select the finished PDF and explicitly approve its package against source A.
2. Record the fictional adapter's newer posting B: Python plus signal processing; deadline 1 March instead of 1 April 2027. The source comparison and hold preserve the earlier package. Attempting the old review returns HTTP409 with code `posting_changed` even though its historical approved flag remains true.
3. Use **Prepare updated posting**, inspect **Document**, then **Approve this document**. The new package has the same PDF bytes and a different posting binding. Close and reopen the owned store: the current approved package, both sources and original document persist.

Campaign stayed off. The one adapter read returned fixed synthetic text. No model call, submission attempt/run, employer network request or account connection occurred. A ready document is not a completed application. Package IDs and observation times identify this recorded run; fresh runs legitimately differ.

## Read offline

Extract the downloaded reader, then run:

```sh
python3 -B reopen.py
# Node 24.14+; only built-in Node modules, no installation:
node native-reopen.mjs
```

The Python reader verifies all bundle member bytes and recorded relationships. The Node reader uses exact current `Store` and `PostingObservations` source to refuse the old binding, accept the current one and refuse an altered content binding in a disposable store. Both verify the public synthetic PDFs. This is a small native guard replay, not a full application restoration or a new employer/browser run. The archive contains all files referenced by those readers, the source closure and original MIT notice.

For the complete UI, use the source repository's locked setup and **Internships → Settings → Open fixture workspace**. The new case is richer than that default seed. The actual source's supported rehearsal methods arrange the retained source transition; no general model agent or invented submission service is used. No application code changed for this presentation.

The app's ledger export deliberately omits artifact paths and credentials; it is not a complete backup or an import/restore format. Keep real ledger exports and backups private. These published records contain only the explicitly fictional case. Full backup/restore, dispatch uncertainty, account and document-rendering boundaries remain in the repository's operation and recovery guide.

[Actual desktop source comparison](posting-desktop.png) · [phone source hold](posting-phone.png) · [figure](binding.svg) · [portrait figure](binding-mobile.svg).
