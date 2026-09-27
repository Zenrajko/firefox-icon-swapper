# PLAN.md

## Goal

Let a user give an individual bookmark on the Firefox bookmarks toolbar a custom icon, using the least fragile technique available to a WebExtension.

## Approaches considered

| Approach | How | Verdict |
|---|---|---|
| Edit `places.sqlite` favicon blobs | Directly rewrite `moz_icons` while Firefox is closed | **Rejected.** Blob is PEM-wrapped, not raw image; Firefox overwrites it on the next favicon refetch; risks DB corruption; must write to the profile manually. |
| `webRequest.filterResponseData()` | Intercept favicon network reads, swap bytes with your icon (theme-aware via `browser.theme`) | **Rejected as primary.** Viable but heavy: needs `webRequest` + `webRequestFilterResponse` + `<all_urls>` host permissions, only fires on network fetches (cached icons bypass it), and fighting the favicon cache is fragile. |
| **`userChrome.css` overlay (chosen)** | Paint the custom icon as a `background-image` on `.bookmark-item` and hide the favicon | **Chosen.** Pure render-time, no data changes, no host permissions, trivially supports per-bookmark mapping. |

> Design iteration (v1.1): the original plan shipped light/dark variants (`@media (prefers-color-scheme: dark)`) and a bookmark `<select>` on the options page. Both were dropped as UX simplification — a single icon matching whatever theme you're on, and a fixed target bookmark chosen by right-clicking — so "switch theme, re-apply" replaced dual icons. `generateCss()` and the storage model were reduced accordingly.

Trade-offs accepted for the chosen approach:

- Requires a one-time manual `about:config` flip and manual CSS paste — WebExtensions cannot set preferences or write to the profile directory. (Documented prominently in README.)
- Local to one profile; doesn't sync.
- Matched by bookmark title (`label` attribute), so duplicate titles collide and renamed bookmarks break the match.
- Selectors can break on Firefox UI redesigns.

### Capture feature: permission trade-off

Reading another bookmark's icon requires extension access to a favicon. Firefox has no API for the favicon database and (unlike Chrome) no `_favicon/` endpoint, so the options are:

- `tabs` permission → `tab.favIconUrl` (reuse an open tab, else one brief background tab)
- `host_permissions` + content script → heavier, more invasive
- `tabHide` permission → hides the background tab entirely, but is an extra sensitive permission for cosmetics only

Chosen: the **least-permissive compromise** that is also light at runtime — `tabs`, reusing an already-open tab when present and otherwise opening (then closing) a single background tab. `tabHide` was deliberately left out: its only benefit is hiding the one-off tab, at the cost of another declared permission.

## Target user flow

1. Right-click bookmark on the bookmarks toolbar → **Set custom icon…** (context `bookmark`, `info.bookmarkId`).
2. `background.js` stashes `{id, label}` in `icSwapperPending` and opens the options page.
3. Options page shows that bookmark as the fixed target. The user chooses an icon either from a file (image/*, read as a data URL) or by reusing another bookmark's icon (its stored custom icon, or a live fetch of its site icon where the site allows it).
4. **Apply** stores `icSwapperIcons[bookmarkId] = {label, light}` in `browser.storage.local`, generates the CSS, and copies it to the clipboard.
5. User pastes the clipboard contents into `chrome/userChrome.css` and restarts.
6. **Remove custom icon** (context menu) deletes the mapping.
7. **Capture icon** (context menu): `background.js` runs `captureBookmarkIcon()` in the event page — reuse an open tab or create a brief background tab, read `tab.favIconUrl`, `downloads.download` it to disk (`saveAs`), then stop. The page does not open on success; only a failed capture opens the options page (via `icSwapperPending` with `action: "capture-error"`) to show the reason.

## Architecture

```
background.js                     options page (options/*)
---------------                   ------------------------------------
menus.create("bookmark")   ───►   fixed target bookmark (from icSwapperPending)
menus.onClicked                  icon source: <input type="file"> → FileReader → data URL
  ├─ pending {id,label}             or reuse: reuse-dropdown → background copySiteIcon()
  ├─ capture → downloads.download   apply: storage.local icSwapperIcons → generateCss → clipboard
  └─ remove → delete mapping        copy (clipboard) in the same click; steps 6–7 enable
```

Data model (`browser.storage.local`):

```js
icSwapperPending: { id, label, action?: "capture-error", message? }  // why the page opened
icSwapperIcons:   { [bookmarkId]: { label, light: <dataURL> } }
```

Generated CSS per mapping:

```css
#PlacesToolbar .bookmark-item[label="<title>"] {
  -moz-appearance: none !important;
  background-image: url("data:...") !important;
  background-repeat: no-repeat !important;
  background-position: left center !important;
  background-size: 16px 16px !important;
  padding-inline-start: 18px !important;
}
#PlacesToolbar .bookmark-item[label="<title>"] > .toolbarbutton-icon {
  display: none !important;
}
```

A bookmark with no title (a bare icon on the toolbar) is emitted as
`#PlacesToolbar .bookmark-item[label=""], #PlacesToolbar .bookmark-item:not([label])`
instead, because the only identifying attribute Firefox exposes on a toolbar button is `label`.

Rationale: paint the custom icon as a `background-image` on the bookmark button and hide the real favicon. `background-image` paints on any element; `list-style-image` does not paint on XUL boxes at all (only on `display: list-item`), so icon-stack/`list-style-image` overrides on `.toolbarbutton-icon` were tried and rendered nothing. `-moz-appearance: none` keeps a themed button background from covering the image, `background-position: left center` + `padding-inline-start` reserve the icon's 16px slot in front of the label, and `background-size` fits the toolbar's icon box. The favicon must be hidden with `display: none`; `visibility: hidden` was tried and left the real favicon painted, so the button ended up showing the custom icon *and* the original side by side. Data URLs keep the CSS portable (no `file://` paths, no `moz-extension://` UUID baked in). Labels are CSS-escaped (`\` and `"`).

## Milestones / progress

- [x] Decision: userChrome.css overlay (this plan).
- [x] Context menu → pending → options page flow (fixed target bookmark, no picker).
- [x] Icon source: single file picker + "reuse another bookmark's icon" (copy stored custom icon or live-fetch site icon).
- [x] CSS generator; Apply saves the icon, generates the CSS, and copies it to the clipboard.
- [x] Capture a bookmark's own icon via a context-menu item (**Capture icon**), routed through `captureBookmarkIcon()` in the background script (`tabs` permission → `tab.favIconUrl` → `downloads.download`), reusing an open tab when possible; failed captures surface through `icSwapperPending`. See "Capture feature: permission trade-off" above.
- [ ] Future work:
  - Build/publish pipeline (web-ext build + AMO signing), or a user.js helper script in the repo.
  - Match on something stabler than `label` (position handling for duplicate titles).
  - Optional `userContent.css` extension of the same trick to other surfaces.
  - Alternative: `webRequest.filterResponseData` mode for users who want the icon to follow the real favicon (todo: re-evaluate cache behavior).

## Risks

- **Fragility:** Firefox may rename/restructure the toolbar selectors. Mitigation: single generator function, documented.
- **Data URL size:** large icons bloat the CSS/paste. Encourage 16–32px icons.
- **Ambiguous selectors:** duplicate titles. Documented in README.