import { createSignal, createResource, onCleanup } from "solid-js";
import { useKeyboard } from "@opentui/solid";

export default function HistoryTuiPlugin(api: any) {
  const client = api.client;
  const [selectedIdx, setSelectedIdx] = createSignal(0);

  const [sessions] = createResource(async () => {
    try {
      const r = await client.session.list();
      if (!r.data) return [];
      return [...r.data].sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    } catch { return []; }
  });

  function toast(msg: string, variant = "info") {
    api.ui.toast({ message: msg, variant, duration: 3000 });
  }

  const disposeCmds = api.command.register(() => [
    {
      title: "History: Recent Sessions",
      value: "history:recent",
      description: "Browse recent session history",
      category: "history",
      slash: { name: "recent" },
      onSelect: () => { api.route.navigate("history"); },
    },
    {
      title: "History: Fork Current",
      value: "history:fork-current",
      description: "Fork the current session",
      category: "history",
      slash: { name: "fork" },
      onSelect: async () => {
        try {
          const current = api.route.current;
          const sid = current?.params?.sessionID ?? "";
          if (!sid) { toast("No active session", "warning"); return; }
          const r = await client.session.fork({ sessionID: sid });
          if (r.data?.id) {
            await client.tui.selectSession({ sessionID: r.data.id });
            toast(`Forked to ${r.data.id.slice(0, 8)}`, "success");
          }
        } catch (e: any) { toast(`Fork failed: ${e.message}`, "error"); }
      },
    },
  ]);

  api.route.register([
    {
      name: "history",
      render: () => {
        useKeyboard((evt: any) => {
          if (evt.eventType !== "keydown") return;
          const list = sessions() ?? [];
          const idx = selectedIdx();
          if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
            evt.preventDefault();
            setSelectedIdx(Math.max(0, idx - 1));
          } else if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
            evt.preventDefault();
            setSelectedIdx(Math.min(list.length - 1, idx + 1));
          } else if (evt.name === "return") {
            evt.preventDefault();
            const cur = list[idx];
            if (cur) client.tui.selectSession({ sessionID: cur.id });
          } else if (evt.name === "f" && !evt.ctrl) {
            evt.preventDefault();
            const cur = list[idx];
            if (cur) {
              client.session.fork({ sessionID: cur.id }).then((r: any) => {
                if (r.data?.id) {
                  client.tui.selectSession({ sessionID: r.data.id });
                  toast(`Forked to ${r.data.id.slice(0, 8)}`, "success");
                }
              });
            }
          } else if (evt.name === "escape") {
            evt.preventDefault();
            api.route.navigate("home");
          }
        }, { target: "app" });

        return null;
      },
    },
  ]);

  onCleanup(() => { disposeCmds(); });
}
