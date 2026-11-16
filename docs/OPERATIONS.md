# Operation and recovery

The default private runtime is `~/Library/Application Support/Automation Hub`. `live/` contains the real ledger, encrypted app vault and retained artifacts. `rehearsal/` is synthetic. `backups/` holds recovery snapshots and `runtime/` contains locally installed tools. Do not publish any of these directories.

Home shows the retained US internship observation total, selected roles, documents and employer-confirmed outcomes, plus a next action drawn from the saved work. Open Needs You for waiting questions, the application queue for selected work or Discover for employer observations. Source freshness and the role's current queue eligibility remain visible in Discover.

Use Discover to find US internships. **Add source** saves a public Greenhouse or Lever employer board locally. **Check jobs** explicitly refreshes that board's public openings. Assess geography from employer-supplied job-location evidence, with unknown or ambiguous locations retained for review. A regional board hostname does not determine job geography. Actual employer forms remain separately verified. No resume, AI connection, employer account or campaign enablement is needed to browse or save roles.

Discover starts on **US internships**, using an internship keyword check and explicit US location evidence. **All jobs** shows broader observations; **Review uncertain locations** preserves unknown or conflicting locations for review. Search and keyword filters cover all retained observations before Previous/Next controls divide matches into pages of 40. Employer posted dates, first found dates and last observed times have different meanings. Partial, stale, failed and disconnected sources keep dated earlier observations or unknown availability. Large-board metadata-only coverage is disclosed because field keywords cannot search omitted descriptions. Refresh when needed and inspect the full employer posting before deciding.

Season shortcuts apply ordinary keywords to supplied employer text. They do not establish job dates or eligibility. The Home total describes retained observations and can include older listings; use Check jobs before adding a role whose availability needs confirmation.

Saving is a shortlist action. **Add to application queue** explicitly selects a fresh role for preparation. Confirmation is a separate application-ledger outcome that needs matching employer evidence. Source checks and saving do not enable campaign authority.

Unsaved Needs You text and choices survive view changes only within the current UI session and matching question/profile/posting/document context. Switching real/fixture workspaces clears that temporary cache. Save answers explicitly before reloading or closing the UI. Writing reviews and supporting-file checks still require their current exact context.

Supported custom Greenhouse choices are static single-choice fields with verified question, form, owned menu/options and selected readback. Unknown wrappers, interactive options, search/geocoder, asynchronous, creatable and multichoice controls stay manual. Supply missing GPA or eligibility facts yourself; browsing or a selected option never invents those facts.

The source launcher stays attached to its terminal. Ctrl+C stops it. Closing a browser tab does not stop the backend. The native shell intentionally leaves its user-started worker running when its window closes. No login item or system daemon is installed.

The native opening panel waits for both the current primary page navigation and its React workspace commit. A failed or timed-out display offers explicit **Reconnect** and **Open in Browser** recovery. Preview windows cannot declare the main display ready. Reconnect obtains a fresh private display session; it does not replay a submit or start another campaign. Readiness here describes the display, so still inspect any connection or application hold in the workspace.

Use the workspace's Pause or Stop control to prevent subsequent campaign work. These controls do not undo a completed external action. After restart or long sleep, review paused work and reconcile uncertain submissions before resuming.

Settings provides a credential-free ledger export and a separate private backup. A ledger export is not a complete document backup. Keep full backups private even when their vault is encrypted.

Before restoring, stop the hub and preserve the actual current runtime bytes, including SQLite WAL/SHM files if present. Reconcile submissions after the backup date. Restore a complete matching snapshot to the same runtime location because retained artifact paths refer to it. Do not mix a database and documents from different snapshots. Keep the preserved current copy until the restored documents, history and connections have been inspected. Leave campaigns paused until uncertainty is resolved.

Supported optional configuration uses `HUB_PORT`, absolute `HUB_DATA_DIR`, `HUB_CODEX_BIN`, `HUB_SOFFICE_BIN` and `PLAYWRIGHT_BROWSERS_PATH`. The build-only `HUB_NODE_LICENSE` selects the matching Node distribution's complete license file when it has a different installation layout. Do not place secrets in these settings or commit generated `native-config.json` and native build receipts. Configure service secrets only through the intended app-vault route.
