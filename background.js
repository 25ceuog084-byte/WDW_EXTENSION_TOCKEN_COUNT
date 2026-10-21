// Background service worker. It collects your usage from two places, saves it,
// shows it on the toolbar icon, and notifies you when your session resets.
//   A. after every reply: the usage report Claude adds to the reply  -> handleReply()   (works on the FREE plan)
//   B. every 30 seconds: claude.ai's /usage page                      -> refreshUsage() (paid plans only; empty on free)
// The popup and the floating meter only read what was saved here.
//
// Debug: chrome://extensions -> "service worker" -> Console

const DEFAULTS = { notify: true, notifyAt: 80, notifyOnLimit: true, showWidget: true };

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...settings };
}

async function getJson(path) {
  const res = await fetch("https://claude.ai/api" + path, { credentials: "include" }); // your login cookie is sent automatically
  if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
  return res.json();
}

// ---------- reading the numbers ----------

// A limit looks like { pct: 0-100, resetsAt: time in ms }.
function makeLimit(percent, resetsAt) {
  if (!(percent >= 0)) return null; // also rejects "not a number"
  return { pct: Math.min(100, Math.round(percent)), resetsAt: new Date(resetsAt).getTime() || null };
}

// A: one limit from the reply. There, utilization is a fraction (0.5 = 50%) and the time is in seconds.
function streamLimit(w) {
  if (!w || !w.resets_at) return null;
  const percent = w.status === "exceeded_limit" ? 100 : w.utilization * 100;
  return makeLimit(percent, w.resets_at * 1000);
}

// B: the /usage page comes in one of two formats, so we handle both.
function parseUsage(raw) {
  const usage = { session: null, weekly: null };
  if (Array.isArray(raw.limits) && raw.limits.length) {
    for (const l of raw.limits) {
      if (l.kind === "session") usage.session = makeLimit(l.percent, l.resets_at);
      if (l.kind === "weekly_all") usage.weekly = makeLimit(l.percent, l.resets_at);
    }
  } else {
    if (raw.five_hour) usage.session = makeLimit(raw.five_hour.utilization, raw.five_hour.resets_at);
    if (raw.seven_day) usage.weekly = makeLimit(raw.seven_day.utilization, raw.seven_day.resets_at);
  }
  return usage;
}

// ---------- saving ----------

// Both sources end up here. Also: if the old session has just ended, notify (once).
async function saveUsage(next) {
  const { usage: old } = await chrome.storage.local.get("usage");
  const settings = await getSettings();
  const sessionEnded = old && old.session && old.session.resetsAt && Date.now() >= old.session.resetsAt
    && (!next.session || next.session.resetsAt !== old.session.resetsAt);
  if (sessionEnded && settings.notify && old.session.pct >= settings.notifyAt) {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png",
      title: "Claude usage is back", message: "Your 5-hour session has reset. You can keep chatting." });
  }
  await chrome.storage.local.set({ usage: { ...next, fetchedAt: Date.now() } });
  await updateBadge();
}

const stillRunning = (limit) => (limit && (!limit.resetsAt || Date.now() < limit.resetsAt) ? limit : null);

// A: a reply just finished.
async function handleReply(m) {
  const windows = (m.messageLimit && m.messageLimit.windows) || {};
  console.log("[usage-meter] reply finished:", JSON.stringify(windows));
  const { usage: old } = await chrome.storage.local.get("usage");
  await saveUsage({
    session: streamLimit(windows["5h"]) || (old && old.session) || null,
    weekly: streamLimit(windows["7d"]) || (old && old.weekly) || null
  });
}

// B: ask claude.ai's /usage page.
async function refreshUsage() {
  try {
    const orgs = await getJson("/organizations");
    const org = orgs.find((o) => (o.capabilities || []).includes("chat")) || orgs[0]; // the account you're signed in to
    const raw = await getJson(`/organizations/${org.uuid}/usage`);
    console.log("[usage-meter] /usage answer:", JSON.stringify(raw));
    let fresh = parseUsage(raw);

    if (!fresh.session && !fresh.weekly) {
      // Free plan: /usage is empty. Keep what the replies told us (minus anything that has ended).
      const { usage: old } = await chrome.storage.local.get("usage");
      fresh = { session: stillRunning(old && old.session), weekly: stillRunning(old && old.weekly) };
    }
    await saveUsage(fresh);
  } catch (e) {
    console.log("[usage-meter] could not get usage:", String(e));
  }
}

// ---------- toolbar badge ----------

async function updateBadge() {
  const { view } = await getState();
  const pct = view.session ? view.session.pct : 0;
  await chrome.action.setBadgeText({ text: view.session ? pct + "%" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: pct >= 90 ? "#d6453d" : pct >= 70 ? "#c98a00" : "#2f6fed" });
}

// ---------- what the popup and the floating meter read ----------

async function getState() {
  const { usage } = await chrome.storage.local.get("usage");
  const u = usage || {};
  const session = stillRunning(u.session);
  const weekly = stillRunning(u.weekly);

  let blocked = null; // "blocked" = a limit is at 100%, so you can't send messages
  if (session && session.pct >= 100) blocked = { kind: "session", resetsAt: session.resetsAt };
  else if (weekly && weekly.pct >= 100) blocked = { kind: "weekly", resetsAt: weekly.resetsAt };

  return {
    view: { session, weekly, scoped: [], extra: null, fetchedAt: u.fetchedAt || null, blocked },
    settings: await getSettings(),
    // Not used in this simple version, but popup.js expects them to exist:
    history: [], messagesLeft: null, signedIn: true, account: { id: null, label: null, count: 1 }
  };
}

// ---------- messages from popup.js and content.js ----------

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  (async () => {
    if (m.type === "sse") await handleReply(m);
    if (m.type === "refreshUsage") await refreshUsage();
    if (m.type === "setSettings") {
      const s = m.settings;
      await chrome.storage.local.set({ settings: { notify: !!s.notify, notifyOnLimit: !!s.notifyOnLimit,
        showWidget: !!s.showWidget, notifyAt: Math.min(100, Math.max(1, Number(s.notifyAt) || 80)) } });
    }
    reply(await getState());
  })();
  return true; // we will answer later
});

// ---------- timer: every 30 seconds ----------

chrome.alarms.onAlarm.addListener(refreshUsage);
function start() {
  chrome.alarms.create("poll", { periodInMinutes: 0.5 });
  refreshUsage();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
