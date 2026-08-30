# KeySwitcher threat model

Baseline established by a full static audit of **v0.2.6 (commit 7166f68)**. A diff is clean only if it does not weaken any baseline below. Cite `file:line` at the new tag for every judgement.

## Audited baseline (v0.2.6)

- **Network egress lives only in `LLMPolisher.swift`.** Two paths: the default worker `https://qkb-llm.graninilya.workers.dev` (POST `{model, text}`, no auth) and an optional user-set OpenAI-compatible endpoint. Both fire **only** from the `polishText` hotkey (`AppDelegate.polishText`). No `URLSession`/socket anywhere else.
- **Update channel:** Sparkle. `SUFeedURL = https://github.com/graninilya/keyswitcher/releases/latest/download/appcast.xml`, `SUPublicEDKey = +VYV2MzhMzAQl+Qwb7wPPR4HldDmiINfqpiU8kva9Mo=`. Updates are EdDSA-verified against that key.
- **Capture:** `CGEvent.tapCreate(..., options: .listenOnly, ...)`, event mask `keyDown | flagsChanged` only. Password fields excluded by `IsSecureEventInputEnabled()` in `KeystrokeBuffer.handle`.
- **Storage:** `UserDefaults` only — settings plus lowercased wrong-layout word-sets. No SQLite, no file-based keystroke log.
- **Persistence:** `SMAppService.mainApp` login item, user-toggled. No `LaunchDaemon`/`LaunchAgent`.
- **Dependencies:** one SPM dep, official `sparkle-project/Sparkle` (`from: "2.6.0"`); no `Package.resolved`.
- **No dynamic code in the app:** no `dlopen`/`dlsym`/`NSClassFromString`-for-exec/`Process`/`NSTask`/`system`/`popen`/`NSAppleScript` in app sources (the only `osascript` is in the DMG-layout build script).
- **Known caveat, not a regression:** `os.log` lines log typed/selected text at `privacy: .public`. Already accepted; only flag if a diff widens what is logged or where it goes.

## Red flags per category (block until explained)

- **Network:** any new `URLSession`/`URLRequest`/`URL(string:`/`NWConnection`; any new host or domain; any send not gated behind an explicit user action (auto-send of typed text); anything that makes `aiEnabled` exfiltrate more.
- **Update integrity:** any change to `SUPublicEDKey` (key rotation — high-risk, confirm it is the author's intentional rotation before trusting), any `SUFeedURL` host change, anything disabling EdDSA verification.
- **Capture:** tap `options` changed away from `.listenOnly`; new event types in the mask (`keyUp`, mouse content); removal or weakening of the `IsSecureEventInputEnabled()` guard.
- **Storage / persistence:** any file or DB write of keystrokes; any new `LaunchDaemon`/`LaunchAgent`; writes outside `UserDefaults`/the app container; plaintext secrets.
- **Dependencies:** any new `.package(` or `binaryTarget` (especially with a download URL); any change to Sparkle's source repo or version source.
- **Dynamic code:** any `dlopen`/`dlsym`/`NSClassFromString`+`perform`/`Process`/`NSTask`/`system`/`popen`/`NSAppleScript` added to app sources.
- **CI / `.github/`:** new secrets, new `curl`/network calls in `release.yml` or the scripts, changed signing identity, build steps that fetch and run extra code.
- **Entitlements / `Info.plist`:** any new entitlement, sandbox change, new usage-description string implying a new capability (camera/mic/contacts/full-disk), or a changed bundle id.

The script's grep hit list only covers added lines matching these patterns. Renames, deletions of a guard, and logic changes inside an existing function will not show there — read the full diff.
