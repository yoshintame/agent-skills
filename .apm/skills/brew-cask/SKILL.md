---
name: brew-cask
description: Create a personal Homebrew cask for a macOS app not available in official repos. Use when the user wants to add an unmanaged app (installed from DMG/direct download) to their personal Homebrew tap yoshintame/cask so it gets tracked in Brewfile and auto-updated.
argument-hint: <app name>
---

# Create Personal Homebrew Cask

Create a cask in the personal tap `yoshintame/cask` ([GitHub repo](https://github.com/yoshintame/homebrew-cask)) for a macOS app that has no official Homebrew cask.

The tap has a CI workflow that auto-bumps cask versions weekly via `brew livecheck`.

## Step 1 — Gather app metadata

The app must already be installed in `/Applications`. Read its Info.plist:

```bash
APP="/Applications/$ARGUMENTS.app"
echo "=== Bundle ID ==="
defaults read "$APP/Contents/Info.plist" CFBundleIdentifier
echo "=== Version ==="
defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString
echo "=== Sparkle Feed ==="
defaults read "$APP/Contents/Info.plist" SUFeedURL 2>/dev/null || echo "No Sparkle feed"
echo "=== Min macOS ==="
defaults read "$APP/Contents/Info.plist" LSMinimumSystemVersion 2>/dev/null || echo "Not specified"
echo "=== Arch ==="
file "$APP/Contents/MacOS/"* | head -3
echo "=== Signing ==="
codesign -dvvv "$APP" 2>&1 | grep "Authority="
```

If the app isn't found, ask the user for the exact `.app` name.

## Step 2 — Find download URL

Use the metadata from Step 1 to determine the download source. Try in this order:

### A. Sparkle appcast (best — enables automatic livecheck)

If `SUFeedURL` was found, fetch it and extract the latest enclosure URL:

```bash
curl -fsSL "<sparkle_url>" | grep -o 'url="[^"]*"' | tail -1
```

The URL pattern should include the version so it can be templated as `#{version}`.

### B. GitHub releases

Search the web for the app name + "github releases". If found, the URL pattern is:
```
https://github.com/OWNER/REPO/releases/download/vVERSION/App-VERSION.dmg
```

### C. Direct download page

Search the app's homepage for a stable download URL. Check if the URL contains the version number.

### D. Electron app-update.yml

For Electron apps without Sparkle:
```bash
cat "/Applications/$APP_NAME.app/Contents/Resources/app-update.yml"
```

If no stable versioned download URL can be found, tell the user this app can't be reliably cask'd and suggest tracking it in `hosts/lasthaze-mbp/packages/Appsfile.unmanaged` instead.

## Step 3 — Download and compute SHA256

```bash
curl -fsSL -o /tmp/app-download "DOWNLOAD_URL"
shasum -a 256 /tmp/app-download
```

## Step 4 — Create the cask file

Write to `/opt/homebrew/Library/Taps/yoshintame/homebrew-cask/Casks/<cask-name>.rb`.

The cask name should be lowercase-hyphenated (e.g., `my-app`).

### Template for Sparkle-based apps

```ruby
cask "app-name" do
  version "X.Y.Z"
  sha256 "abc123..."

  url "https://example.com/download/App-#{version}.dmg"
  name "App Name"
  desc "One-line description"
  homepage "https://example.com/"

  livecheck do
    url "https://example.com/updates/appcast.xml"
    strategy :sparkle, &:short_version
  end

  depends_on macos: ">= :sonoma"
  depends_on arch: :arm64  # only if ARM-only

  app "App Name.app"
end
```

### Template for GitHub releases

```ruby
cask "app-name" do
  version "X.Y.Z"
  sha256 "abc123..."

  url "https://github.com/OWNER/REPO/releases/download/v#{version}/App-#{version}.dmg"
  name "App Name"
  desc "One-line description"
  homepage "https://github.com/OWNER/REPO"

  livecheck do
    url "https://github.com/OWNER/REPO/releases/latest"
    strategy :github_latest
  end

  app "App Name.app"
end
```

### Livecheck strategies

| Source | Strategy |
|---|---|
| Sparkle XML | `strategy :sparkle, &:short_version` |
| GitHub releases | `strategy :github_latest` |
| Download page with version in filename | `strategy :page_match, /App-(\d+(?:\.\d+)+)\.dmg/` |

### Notes

- Use `.dmg` artifacts over `.zip` when both available
- `depends_on arch: :arm64` only if the app is ARM-only (check Step 1 output)
- `depends_on macos:` — use the LSMinimumSystemVersion from Step 1
- macOS codenames: `:sonoma` (14), `:sequoia` (15), `:tahoe` (16), `:monterey` (12), `:ventura` (13)

## Step 5 — Install or adopt

```bash
# If the app is already in /Applications:
brew install --cask --adopt yoshintame/cask/<cask-name>

# If installing fresh:
brew install --cask yoshintame/cask/<cask-name>
```

If adopt fails due to version mismatch (installed version differs from cask version), use `--force` to replace with the latest:

```bash
brew install --cask --force yoshintame/cask/<cask-name>
```

## Step 6 — Push and update Brewfile

```bash
git -C /opt/homebrew/Library/Taps/yoshintame/homebrew-cask add -A
git -C /opt/homebrew/Library/Taps/yoshintame/homebrew-cask commit -m "feat: add <cask-name> cask"
git -C /opt/homebrew/Library/Taps/yoshintame/homebrew-cask push
```

Then dump Brewfile to capture the new entry:

```bash
brew bundle dump --force --file="$HOME/.dotfiles/hosts/lasthaze-mbp/packages/Brewfile"
```

## Step 7 — Verify livecheck

```bash
brew livecheck yoshintame/cask/<cask-name>
```

If livecheck reports the correct version, the CI workflow will handle future updates automatically.

## Rules

- Always check `brew search --cask <name>` first — if an official cask exists, use that instead
- Never create a cask without a stable, versioned download URL
- Always include a `livecheck` block so CI can auto-update
- Use the `--adopt` flag for apps already installed in /Applications
- Commit messages: `feat: add <name> cask` for new, `fix: update <name> cask` for changes
