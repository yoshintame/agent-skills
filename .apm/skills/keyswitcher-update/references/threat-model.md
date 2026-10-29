# KeySwitcher threat model

Baseline established by a full static audit of v0.2.6 (commit 7166f68), carried forward by a diff audit to **v0.3.0 (commit 0a51fc2)**. A diff is clean only if it does not weaken any baseline below. Cite `file:line` at the new tag for every judgement.

## Audited baseline (v0.3.0)

- **Network egress lives only in `LLMPolisher.swift`,** over its own ephemeral `URLSession` from `LLMTransport.swift` (no cache, recreated after two network errors). Paths: the default worker `https://qkb-llm.graninilya.workers.dev` (POST `{model, text}`, no auth), then each user-set `aiMirrorURLs` entry in order (empty by default), or an optional user-set OpenAI-compatible endpoint. All fire **only** from the `polishText` hotkey (`AppDelegate.polishText`). No other `URLSession`/socket.
- **Update channel:** Sparkle. `SUFeedURL = https://github.com/graninilya/keyswitcher/releases/latest/download/appcast.xml`, `SUPublicEDKey = +VYV2MzhMzAQl+Qwb7wPPR4HldDmiINfqpiU8kva9Mo=`. Updates are EdDSA-verified against that key.
- **Capture:** `CGEvent.tapCreate(..., options: .listenOnly, ...)`, event mask `keyDown | flagsChanged` only. Password fields are excluded through `SecureInput.isEnabled`: `IsSecureEventInputEnabled()` cached for 150 ms, forced to recheck on Tab/Return, app activation and mouse clicks; the buffer is fully cleared on each secure-input transition (`KeystrokeBuffer.handle`). AX selection reads (`SelectionDetector`) are skipped under secure input too.
- **Storage:** `UserDefaults` for settings, lowercased wrong-layout word-sets, per-app rules and counters. The custom API key lives in Keychain (`KeychainStore`, service `com.granin.keyswitcher`) and is never exported. The replacement history (`History`) is RAM-only. No SQLite, no file-based keystroke log. Settings export/import goes only through a user-picked file.
- **Persistence:** `SMAppService.mainApp` login item, user-toggled. No `LaunchDaemon`/`LaunchAgent`.
- **Dependencies:** one SPM dep, official `sparkle-project/Sparkle` (`from: "2.6.0"`); no `Package.resolved`.
- **No dynamic code in the app:** no `dlopen`/`dlsym`/`NSClassFromString`-for-exec/`Process`/`NSTask`/`system`/`popen`/`NSAppleScript` in app sources (the only `osascript` is in the DMG-layout build script). CLI flags `--self-test` and `--test-injection` run local checks only.
- **Logging:** user text goes through `Log.redact` (length and script composition only); plaintext only with the `QKBVerboseLogging` default. Flag any `privacy: .public` interpolation of raw user text.
- **Known baked-in literal:** `https://ya.ru/a,b` is typography self-test data (`SelfTest.swift`), never fetched.

## Red flags per category (block until explained)

- **Network:** any new `URLSession`/`URLRequest`/`URL(string:`/`NWConnection`; any new host or domain; any send not gated behind an explicit user action (auto-send of typed text); anything that makes `aiEnabled` exfiltrate more.
- **Update integrity:** any change to `SUPublicEDKey` (key rotation — high-risk, confirm it is the author's intentional rotation before trusting), any `SUFeedURL` host change, anything disabling EdDSA verification.
- **Capture:** tap `options` changed away from `.listenOnly`; new event types in the mask (`keyUp`, mouse content); removal or weakening of the secure-input guard (dropped `SecureInput` check, longer cache TTL, fewer forced rechecks).
- **Storage / persistence:** any file or DB write of keystrokes; any new `LaunchDaemon`/`LaunchAgent`; writes outside `UserDefaults`/the app container; plaintext secrets.
- **Dependencies:** any new `.package(` or `binaryTarget` (especially with a download URL); any change to Sparkle's source repo or version source.
- **Dynamic code:** any `dlopen`/`dlsym`/`NSClassFromString`+`perform`/`Process`/`NSTask`/`system`/`popen`/`NSAppleScript` added to app sources.
- **CI / `.github/`:** new secrets, new `curl`/network calls in `release.yml` or the scripts, changed signing identity, build steps that fetch and run extra code.
- **Entitlements / `Info.plist`:** any new entitlement, sandbox change, new usage-description string implying a new capability (camera/mic/contacts/full-disk), or a changed bundle id.

The script's grep hit list only covers added lines matching these patterns. Renames, deletions of a guard, and logic changes inside an existing function will not show there — read the full diff.
