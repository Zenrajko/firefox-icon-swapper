const KEYS = { icons: "icSwapperIcons", pending: "icSwapperPending" };
const MENU = {
  set: "icon-swapper-set-icon",
  capture: "icon-swapper-capture-icon",
  clear: "icon-swapper-clear-icon",
};

async function ensureMenus() {
  try {
    await browser.menus.removeAll();
  } catch {
    // first run or startup race; proceed anyway
  }
  browser.menus.create({ id: MENU.set, title: "Set custom icon…", contexts: ["bookmark"] });
  browser.menus.create({ id: MENU.capture, title: "Capture icon", contexts: ["bookmark"] });
  browser.menus.create({ id: MENU.clear, title: "Remove custom icon", contexts: ["bookmark"] });
}

browser.runtime.onInstalled.addListener(ensureMenus);
browser.runtime.onStartup.addListener(ensureMenus);
ensureMenus();

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function faviconExt(url) {
  const mime = {
    "data:image/svg+xml": "svg",
    "data:image/png": "png",
    "data:image/webp": "webp",
    "data:image/jpeg": "jpg",
    "data:image/gif": "gif",
    "data:image/x-icon": "ico",
    "data:image/vnd.microsoft.icon": "ico",
    "data:image/ico": "ico",
  };
  if (url.startsWith("data:")) {
    const semi = url.indexOf(";");
    const mimeType = semi === -1 ? url : url.slice(0, semi);
    return mime[mimeType] || "png";
  }
  try {
    const path = new URL(url).pathname.split("/").pop() || "";
    const dot = path.lastIndexOf(".");
    const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]+/g, "");
    return ext || "png";
  } catch {
    return "png";
  }
}

function samePage(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch {
    return false;
  }
}

async function findOpenTab(url) {
  const tabs = await browser.tabs.query({});
  return tabs.find((t) => t.url && samePage(t.url, url));
}

function waitForFavicon(targetId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the site to publish a favicon."));
    }, timeoutMs);
    const check = (t) => {
      if (t && /^(https?|data):/i.test(t.favIconUrl || "")) {
        cleanup();
        resolve(t.favIconUrl);
      }
    };
    const onUpdated = (tabId, changeInfo, t) => {
      if (tabId === targetId) check(t);
    };
    const cleanup = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.get(targetId).then(check).catch(() => {});
  });
}

async function dataUrlToBlobUrl(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return URL.createObjectURL(blob);
}

async function favIconUrlFor(id) {
  let bm;
  try {
    [bm] = await browser.bookmarks.get(id);
  } catch {
    return { error: "Bookmark not found." };
  }
  if (!bm || !bm.url) return { error: "Bookmark not found." };
  if (!/^https?:/i.test(bm.url)) {
    return { error: "Only http(s) bookmarks expose a favicon." };
  }

  let tab;
  let created = false;
  try {
    tab = await findOpenTab(bm.url);
    if (!tab) {
      tab = await browser.tabs.create({ url: bm.url, active: false });
      created = true;
    }
    const favIconUrl = await waitForFavicon(tab.id, 25000);
    return { bm, favIconUrl };
  } catch (err) {
    return { error: err.message };
  } finally {
    if (created) browser.tabs.remove(tab.id).catch(() => {});
  }
}

async function captureBookmarkIcon(id) {
  const res = await favIconUrlFor(id);
  if (res.error) return { ok: false, error: res.error };
  const filename = `${hostOf(res.bm.url) || "favicon"}-favicon.${faviconExt(res.favIconUrl)}`;
  const isData = /^data:/i.test(res.favIconUrl);
  const dlUrl = isData ? await dataUrlToBlobUrl(res.favIconUrl) : res.favIconUrl;
  try {
    await browser.downloads.download({ url: dlUrl, filename, saveAs: true });
  } finally {
    if (isData) setTimeout(() => URL.revokeObjectURL(dlUrl), 60000);
  }
  return { ok: true, filename };
}

async function copySiteIcon(id) {
  const res = await favIconUrlFor(id);
  if (res.error) return { ok: false, error: res.error };
  if (/^data:/i.test(res.favIconUrl)) return { ok: true, dataUrl: res.favIconUrl };
  try {
    const response = await fetch(res.favIconUrl, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the icon bytes."));
      reader.readAsDataURL(blob);
    });
    return { ok: true, dataUrl };
  } catch {
    return {
      ok: false,
      error:
        "That site doesn't allow reading its icon directly. Right-click it in the toolbar and choose Capture icon to save it to disk instead.",
    };
  }
}

let menuInstanceId = 0;

browser.menus.onShown.addListener(async (info) => {
  const instance = ++menuInstanceId;
  const show = Boolean(info.bookmarkId);
  try {
    await Promise.all(
      Object.values(MENU).map((id) => browser.menus.update(id, { visible: show }))
    );
    if (instance === menuInstanceId) browser.menus.refresh();
  } catch {
    // menu closed before the updates applied; nothing to refresh
  }
});

browser.menus.onHidden.addListener(() => {
  menuInstanceId = 0;
  for (const id of Object.values(MENU)) {
    browser.menus.update(id, { visible: true }).catch(() => {});
  }
});

browser.menus.onClicked.addListener(async (info) => {
  if (!info.bookmarkId) return;
  if (info.menuItemId !== MENU.set && info.menuItemId !== MENU.capture && info.menuItemId !== MENU.clear) return;

  let bm;
  try {
    [bm] = await browser.bookmarks.get(info.bookmarkId);
  } catch {
    return;
  }
  if (!bm || !bm.url) return;

  if (info.menuItemId === MENU.set) {
    await browser.storage.local.set({ [KEYS.pending]: { id: bm.id, label: bm.title || bm.url } });
    await browser.runtime.openOptionsPage();
    return;
  }

  if (info.menuItemId === MENU.capture) {
    const result = await captureBookmarkIcon(bm.id);
    if (!result.ok) {
      await browser.storage.local.set({
        [KEYS.pending]: {
          id: bm.id,
          label: bm.title || bm.url,
          action: "capture-error",
          message: result.error,
        },
      });
      await browser.runtime.openOptionsPage();
    }
    return;
  }

  const icons = (await browser.storage.local.get(KEYS.icons))[KEYS.icons] || {};
  delete icons[bm.id];
  await browser.storage.local.set({ [KEYS.icons]: icons });
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "copySiteIcon") return copySiteIcon(msg.id);
});