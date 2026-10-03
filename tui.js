import { notify } from "./notify.js";
import { CacheBellRPC } from "./rpc.js";

function setup(ctx) {
  const rpc = ctx.client.rpc(CacheBellRPC);
  const controller = new AbortController();
  let timer;
  const openSessions = () => {
    if (ctx.ui.tabs.enabled()) return ctx.ui.tabs.list().map((tab) => tab.sessionID);
    // Without tabs, only the currently viewed session belongs to this client.
    const route = ctx.ui.router.current();
    return route.type === "session" ? [ctx.data.session.root(route.sessionID)] : [];
  };

  async function poll() {
    try {
      const locations = new Map();
      for (const sessionID of openSessions()) {
        const directory = ctx.data.session.get(sessionID)?.location?.directory;
        // Tabs from other projects share the rail. Route each RPC to the
        // session's plugin instance, not the client's initial working directory.
        if (!directory) continue;
        if (!locations.has(directory)) locations.set(directory, { location: { directory }, sessionIDs: [] });
        locations.get(directory).sessionIDs.push(sessionID);
      }
      await Promise.all([...locations.values()].map(async ({ location, sessionIDs }) => {
        try {
          const { warnings } = await rpc.collect({ sessionIDs }, {
            location, signal: controller.signal,
          });
          for (const warning of warnings) {
            // A tab may close while the server response is in flight. Never
            // deliver from that stale snapshot, or after plugin/client cleanup.
            if (controller.signal.aborted || !openSessions().includes(warning.sessionID)) continue;
            const ok = await notify(warning.title, warning.message, warning, {
              signal: controller.signal,
              active: () => openSessions().includes(warning.sessionID),
            });
            if (!ok) console.warn("cachebell: A CacheBell sound/notification failed. Check OS permissions and platform commands.");
          }
        } catch {
          // A location may not have CacheBell enabled, or may be disconnected.
        }
      }));
    } catch {
      // UI data may be unavailable during startup or shutdown. Retry while live.
    } finally {
      if (!controller.signal.aborted) {
        timer = setTimeout(() => void poll(), 1_000);
        timer.unref?.();
      }
    }
  }

  void poll();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

export default { id: "cachebell.tui", setup };
