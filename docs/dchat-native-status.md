# D-Chat native integration: implementation checkpoint

Status: **WIP, not a usable Cindy D-Chat connection**. No production startup hook or
settings/partner binding UI registers the new adapter yet. The transport modules
are not evidence that real partner memory, skills, tools or permissions have run.

## Implemented boundaries

- `packages/lizi-im/src/dchat/` adds configuration validation, a content-free
  durable receipt ledger, admission and output lifecycle, and a `TextChannelIM`
  facade for Cindy's existing orchestrator. It contains no agent engine.
- The optional Desktop adapter uses the existing companion route dependency:
  owner private messages go to canonical; groups/topics/guests go to their lanes.
  `companionRequired` rejects missing/inactive partners and ignores unrelated
  takeover bindings. Other channels retain their existing routing behavior.
- The account, connection, partner, chat, topic and execution generation are bound
  to each receipt. Interrupted dispatches and unknown sends are never replayed.
  Duplicate receipt metadata is retained indefinitely; compaction is not implemented.
- Self-originated messages do not dispatch. Group context collection does not
  authorize execution. Execution chat IDs default to empty; replies default to
  drafts. Draft storage/UI is a required injected dependency, not implemented here.
- Arbitrary side-channel sends are rejected; final output needs an accepted input.
  Guest tool policy uses the existing shared policy and desktop confirmation.
  No D-Chat message can approve a permission. Non-permission interactions require
  further integration with Cindy's existing interaction UI.
- The macOS IPC adapter requires `dchat_im_clean_send_v2` on every send and checks
  the native account. It never patches D-Chat, falls back to another sender or
  automatically retries. A resource acknowledgement is labeled separately from a
  server message key. No real send has been performed.
- An optional installed native CLI reader provides fresh identity and bounded
  history reads. It does not download or run a wrapper/updater. History permission
  or schema failure is explicit. This reader is **not** the local SQLCipher reader.

## Remaining before an end-user build

1. Register connection storage/lifecycle in Desktop under the verified Cindy owner,
   and implement the existing partner/settings entry and explicit chat selection.
2. Finish the macOS local database reader with read-only SQLCipher access and
   in-memory key handling. The CLI reader does not establish equivalent access.
3. Verify native chat membership, exact group invocation metadata and continuous
   history pagination before connecting real incoming messages to `receive`.
   No renderer-provided body may serve as native identity evidence.
4. Persist and restore accepted execution-to-session/destination bindings for long
   task notifications. The current facade retains active lanes only in memory and
   rejects a second active input in the same lane; it is not a durable input queue.
5. Complete cancellation, pending-input interaction and busy-lane handoff through
   the existing coordinator. Preserve shared approvals and plugin-output boundaries.
6. Run Desktop related tests, lint, typecheck, package build and isolated mock
   startup using the repository wrapper. A transport-only simulation does not
   establish a running Cindy application.
7. Build and verify the macOS artifact on a Mac. Linux output cannot serve as a
   macOS package. Verify the actual D-Chat clean-send capability independently.

## Source provenance

Implementation targets the public Cindy commit
`6ef269cd62682236e7e4128c5802572023502285` (Apache-2.0). It is not the same commit
as the installed application referenced during investigation.

Protocol facts were reviewed against QChat 0.4.6, reference commit
`ecc20858bcac488ec030f30f4722139f69b8ec61`, including WorkspaceServer framing and
clean-send capability checks. No QChat source, executable, credentials, database,
account data or dependencies were copied into this change. No explicit QChat
license was established; do not vendor its source without resolving that first.

The shared text output contract now optionally carries the triggering input ID.
D-Chat requires that ID to match its immutable receipt before a terminal commit;
a late terminal cannot consume the next input occupying the same lane. Native
message IDs reused by two chats have distinct internal receipt identities.
The facade snapshots validated configuration at construction.

Tests use synthetic messages, injected native calls and private in-memory stores.
They cover module behavior, not real D-Chat delivery or the original partner's
real memory/tool execution.

## Verified development checkpoint (2026-11-09)

- Node 22.20.0, isolated pnpm 10.33.2 and Git LFS 3.4.1; Desktop dependency
  installation completed without replacing machine-wide tools.
- IM package typecheck, Desktop typecheck and maker-core typecheck passed.
  The new channel literals in source/configuration/permission types are additive;
  companion execution still stores `source=bot`. No SQL migration was added.
- D-Chat module tests: 23 passed across three files, 1.11 seconds combined.
- Shared companion routing and output tests: 47 passed, 30.21 seconds combined
  (25.19 seconds transform; test bodies 100 ms). The existing routing file now
  exercises real D-Chat facade/channel policy -> shared runner -> synthetic
  canonical Session.send -> bound native-send substitute. Existing legacy
  fallback behavior remains tested separately from companion-only refusal.
- Added/changed IM and Desktop files passed targeted ESLint. Test-hygiene passed.
- Migration validation passed all six stages, including unchanged historical
  migration hashes and Drizzle schema validation.
- A Linux amd64 `.deb` development build completed. This validates packaging,
  not an enabled D-Chat connection; the adapter is not registered at startup.
- The isolated Global mock startup wrapper returned `DESKTOP_DEV_VERDICT=failed`:
  the pinned Claude runtime and its CDN fallback could not download. No ready
  product signal, GUI acceptance or real partner memory/tool execution is claimed.
- Developer-doc links check did not pass because upstream linked image assets
  remain absent in this partially hydrated checkout. No assertions were removed.

The installed reference client's commit remains unavailable publicly. This public
checkout and Linux artifact are not that installed version and are not a Mac build.
No real messages, account login, D-Chat patches, production partner configuration,
production profile migrations or replacement of an existing Cindy instance occurred.
