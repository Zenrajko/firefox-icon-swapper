# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## What this is

A Firefox WebExtension (Manifest V3) that lets a user give an individual bookmark on the bookmarks toolbar a custom icon.

The core design decision: WebExtensions cannot modify the browser toolbar UI directly, so the extension generates CSS targeting Firefox's `userChrome.css`, which overlays the icon at render time. No favicon storage is modified.

## Repository structure

- `extension/manifest.json` — MV3 manifest. Permissions: `menus`, `bookmarks`, `storage`, `clipboardWrite`, `downloads`, `tabs` (`tabs` is for `tab.favIconUrl` in the "Capture icon" feature). Background is an event page (`background.scripts`), not a service worker.
- `extension/background.js` — creates the bookmarks context-menu items (Set custom icon…, Capture icon, Remove custom icon) and handles `menus.onClicked`. Uses `info.bookmarkId` (Firefox-specific). Also owns the capture/reuse logic: `captureBookmarkIcon()` (`tabs` → `tab.favIconUrl` → `downloads.download`, from the context menu) and `copySiteIcon()` (returns the icon bytes as a data URL, used by the options page's "reuse another bookmark's icon" via `runtime.onMessage`). Both share `favIconUrlFor()`.
- `extension/options/options.html` / `.js` / `.css` — options page: fixed target bookmark (set by the context menu), file input + reuse-a-toolbar-bookmark's-icon (one shared preview), Generate and copy icon CSS saves the icon, generates the CSS, and copies it to the clipboard (then steps 6–7 enable).
- `extension/icons/icon.svg` — extension icon.
- `README.md` — end-user docs, including the required manual `about:config` step.
- `PLAN.md` — design rationale and approach comparison.

## Key conventions

- **No code comments.** Keep explanations in `README.md`, `PLAN.md`, and commit messages, not in the source.
- Promised `browser.*` APIs only (WebExtension style), no `chrome.*` callbacks.
- No build step. The `extension/` folder is the loadable add-on.
- Storage keys are namespaced: `icSwapperIcons` (mapping bookmark id → `{label, light}`) and `icSwapperPending` (target bookmark set from the context menu, optionally with `action: "capture-error"` when a capture fails).
- The CSS selector strategy and all selectors live in `generateCss()` in `extension/options/options.js`. If Firefox changes toolbar internals, fix it there — see README "Fragile across Firefox redesigns".

## Building / loading

No build. Load the unpacked add-on:

```
about:debugging#/runtime/this-firefox  → Load Temporary Add-on… → extension/manifest.json
```

Or run with web-ext:

```
npx web-ext run --source-dir extension
npx web-ext lint --source-dir extension
```

## Manual user prerequisites (documented in README)

The extension cannot perform these; they must be documented for the user:

1. `about:config` → `toolkit.legacyUserProfileCustomizations.stylesheets = true`.
2. Create `chrome/userChrome.css` in the profile folder and paste the generated CSS.

## Verification checklist

There is no automated test suite and no CI. The project owner is also the tester: all items below are verified by manual testing in a real Firefox, not by the assistant. The assistant can only run the lint step and reason about the code, so after any change, hand the owner a short list of what to check and wait for their report.

Before shipping a change:

1. `npx web-ext lint --source-dir extension` passes (or at least has no errors).
2. Temporary-load the extension in a clean test profile.
3. Right-click a toolbar bookmark → "Set custom icon…" opens the options page showing that bookmark as the target.
4. Choosing a file or "reuse another bookmark's icon" sets a preview; Generate and copy icon CSS saves the icon, generates the CSS, copies it to the clipboard, and enables steps 6–7.
5. Right-click → "Remove custom icon" removes the bookmark's rule from the generated CSS.
6. With the manual steps done, the toolbar bookmark shows the custom icon after restart.

## Testing without a real Firefox

The project owner (PM) is also the tester for this project; there is no automated test suite. The logic most worth unit-testing is `generateCss()` (it is pure); if you add a test harness, keep it dependency-free.