import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface HistoryOptions {
  persistPath?: string;
  maxMessagePreview?: number;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "unknown";
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toISOString().split("T")[0];
}

function formatCost(c: number): string {
  if (c < 0.01) return "$0.00";
  return `$${c.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function extractPreview(parts: any[]): string {
  for (const p of parts) {
    if (p.type === "text" && p.text) return truncate(p.text, 120);
  }
  for (const p of parts) {
    if (p.type === "tool" && p.tool) return `[${p.tool}]`;
  }
  return "[message]";
}

function extractTools(parts: any[]): string[] {
  return parts.filter((p: any) => p.type === "tool" && p.tool).map((p: any) => p.tool);
}

function initDB(db: Database) {
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA cache_size=-64000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT 'untitled',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      pinned INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      cost REAL NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tool_calls TEXT NOT NULL DEFAULT '',
      files_attached INTEGER NOT NULL DEFAULT 0,
      parent_msg_id TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS files (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (session_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_dir ON sessions(directory);
    CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_msg_id);
  `);
}

export const HistoryPlugin = {
  id: "opencode-history",
  server: async (ctx: any, options: HistoryOptions = {}) => {
    const client = ctx.client;
    const { persistPath = "", maxMessagePreview = 120 } = options;
    const defaultDbDir = path.join(os.homedir(), ".local", "share", "opencode", "history");
    const dbPath = persistPath || path.join(defaultDbDir, "history.db");
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    try { mkdirSync(dir, { recursive: true }); } catch {}

    const db = new Database(dbPath, { create: true });
    initDB(db);

    const S = {
      upsertSession: db.prepare(`INSERT INTO sessions (id, project_id, directory, title, created_at, updated_at, model, agent, status, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, directory=excluded.directory, title=excluded.title, updated_at=excluded.updated_at, model=COALESCE(NULLIF(excluded.model,''), sessions.model), agent=COALESCE(NULLIF(excluded.agent,''), sessions.agent), status=excluded.status, parent_id=COALESCE(NULLIF(excluded.parent_id,''), sessions.parent_id)`),
      incSession: db.prepare(`UPDATE sessions SET message_count=message_count+1, updated_at=?, cost=cost+?, tokens_in=tokens_in+?, tokens_out=tokens_out+?, tokens_reasoning=tokens_reasoning+?, model=COALESCE(NULLIF(?,''), model), agent=COALESCE(NULLIF(?,''), agent) WHERE id=?`),
      setStatus: db.prepare(`UPDATE sessions SET status=? WHERE id=?`),
      renameSession: db.prepare(`UPDATE sessions SET title=? WHERE id=?`),
      pinSession: db.prepare(`UPDATE sessions SET pinned=1 WHERE id=?`),
      unpinSession: db.prepare(`UPDATE sessions SET pinned=0 WHERE id=?`),
      deleteSession: db.prepare(`DELETE FROM sessions WHERE id=?`),
      insertMsg: db.prepare(`INSERT OR REPLACE INTO messages (id, session_id, role, created_at, preview, model, cost, tokens_in, tokens_out, tokens_reasoning, tool_calls, files_attached, parent_msg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertFile: db.prepare(`INSERT OR IGNORE INTO files (session_id, path) VALUES (?, ?)`),
      recent: db.prepare(`SELECT * FROM sessions WHERE pinned=0 ORDER BY updated_at DESC LIMIT ?`),
      pinned: db.prepare(`SELECT * FROM sessions WHERE pinned=1 ORDER BY updated_at DESC`),
      search: db.prepare(`SELECT * FROM sessions WHERE (title LIKE ? OR directory LIKE ? OR model LIKE ? OR agent LIKE ?) ORDER BY updated_at DESC LIMIT ?`),
      searchFiles: db.prepare(`SELECT s.* FROM sessions s JOIN files f ON s.id=f.session_id WHERE f.path LIKE ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?`),
      get: db.prepare(`SELECT * FROM sessions WHERE id=?`),
      getByPrefix: db.prepare(`SELECT * FROM sessions WHERE id LIKE ? LIMIT 1`),
      children: db.prepare(`SELECT * FROM sessions WHERE parent_id=? ORDER BY created_at ASC`),
      messages: db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT ? OFFSET ?`),
      messageCount: db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE session_id=?`),
      getMsg: db.prepare(`SELECT * FROM messages WHERE id=?`),
      files: db.prepare(`SELECT path FROM files WHERE session_id=? ORDER BY path`),
      projects: db.prepare(`SELECT directory, COUNT(*) as cnt FROM sessions WHERE directory!='' GROUP BY directory ORDER BY cnt DESC LIMIT ?`),
      projSessions: db.prepare(`SELECT * FROM sessions WHERE directory=? ORDER BY updated_at DESC LIMIT ?`),
      projSessionsFuzz: db.prepare(`SELECT * FROM sessions WHERE directory LIKE ? ORDER BY updated_at DESC LIMIT ?`),
      stats: db.prepare(`SELECT COUNT(*) as total_sessions, COALESCE(SUM(message_count),0) as total_messages, COALESCE(SUM(cost),0) as total_cost, COALESCE(SUM(tokens_in),0) as total_in, COALESCE(SUM(tokens_out),0) as total_out, COALESCE(SUM(tokens_reasoning),0) as total_reasoning, COUNT(DISTINCT directory) as total_projects FROM sessions`),
      fileStats: db.prepare(`SELECT COUNT(DISTINCT path) as total_files FROM files`),
      timeline: db.prepare(`SELECT id, session_id, role, created_at, preview, tool_calls, cost FROM messages WHERE session_id=? ORDER BY created_at ASC`),
      msgSeq: db.prepare(`SELECT id, role, created_at, preview FROM messages WHERE session_id=? AND created_at <= (SELECT created_at FROM messages WHERE id=?) ORDER BY created_at DESC LIMIT ?`),
      msgNext: db.prepare(`SELECT * FROM messages WHERE session_id=? AND created_at > (SELECT created_at FROM messages WHERE id=?) ORDER BY created_at ASC LIMIT 1`),
      msgPrev: db.prepare(`SELECT * FROM messages WHERE session_id=? AND created_at < (SELECT created_at FROM messages WHERE id=?) ORDER BY created_at DESC LIMIT 1`),
      topModels: db.prepare(`SELECT model, COUNT(*) as cnt, SUM(cost) as cost FROM sessions WHERE model!='' GROUP BY model ORDER BY cnt DESC LIMIT 5`),
      topAgents: db.prepare(`SELECT agent, COUNT(*) as cnt FROM sessions WHERE agent!='' GROUP BY agent ORDER BY cnt DESC LIMIT 5`),
      dailyCost: db.prepare(`SELECT date(updated_at/1000, 'unixepoch') as day, COUNT(*) as sessions, SUM(cost) as cost, SUM(tokens_in+tokens_out+tokens_reasoning) as tokens FROM sessions GROUP BY day ORDER BY day DESC LIMIT 14`),
    };

    function upsertSession(s: any) {
      S.upsertSession.run(
        s.id, s.projectID ?? "", s.directory ?? "", s.title ?? "untitled",
        s.time?.created ?? Date.now(), s.time?.updated ?? Date.now(),
        "", "", "idle", s.parentID ?? "",
      );
    }

    async function syncFromServer() {
      try {
        const r = await client.session.list();
        if (r.error || !r.data) return;
        const tx = db.transaction(() => { for (const s of r.data) upsertSession(s); });
        tx();
      } catch {}
    }
    syncFromServer();

    const historyTool = tool({
      description: `Session history browser. Actions: recent, search, session, messages, projects, project, stats, dump, fork, continue, revert, rename, pin, unpin, delete, timeline, goto, next, prev, copy, export, activity, models, agents, pinned.`,
      args: {
        action: tool.schema.enum([
          "recent", "search", "session", "messages", "projects", "project", "stats", "dump",
          "fork", "continue", "revert", "rename", "pin", "unpin", "delete",
          "timeline", "goto", "next", "prev", "copy", "export", "activity", "models", "agents", "pinned",
        ]).optional().describe("Action"),
        query: tool.schema.string().optional().describe("Search query, session ID, or message ID"),
        limit: tool.schema.number().optional().describe("Max results"),
      },
      async execute({ action, query, limit }: { action?: string; query?: string; limit?: number }, ctx: any) {
        const a = action ?? "recent";
        const max = limit ?? 20;

        if (a === "recent") {
          const pinned = S.pinned.all() as any[];
          const rows = S.recent.all(max) as any[];
          const all = [...pinned, ...rows];
          if (all.length === 0) return "No sessions recorded.";
          return all.map((s) => {
            const pin = s.pinned ? "*" : " ";
            const age = formatRelativeTime(s.updated_at);
            const msgs = s.message_count ? `${s.message_count} msgs` : "";
            const cost = formatCost(s.cost);
            const fork = s.parent_id ? "(fork)" : "";
            const meta = [msgs, cost, s.model, s.agent, fork].filter(Boolean).join(" | ");
            return `${pin} ${s.id.slice(0, 8)}  ${s.title}  ${age}  ${meta}`;
          }).join("\n");
        }

        if (a === "pinned") {
          const rows = S.pinned.all() as any[];
          if (rows.length === 0) return "No pinned sessions.";
          return rows.map((s) => `* ${s.id.slice(0, 8)}  ${s.title}  ${formatRelativeTime(s.updated_at)}`).join("\n");
        }

        if (a === "search") {
          if (!query) return "Provide a search query.";
          const pat = `%${query}%`;
          let rows = S.search.all(pat, pat, pat, pat, max) as any[];
          const fr = S.searchFiles.all(pat, max) as any[];
          const seen = new Set(rows.map((r: any) => r.id));
          for (const r of fr) { if (!seen.has(r.id)) { rows.push(r); seen.add(r.id); } }
          rows.sort((x: any, y: any) => y.updated_at - x.updated_at);
          rows = rows.slice(0, max);
          if (rows.length === 0) return `No sessions matching "${query}".`;
          return rows.map((s) => {
            const pin = s.pinned ? "*" : " ";
            const fork = s.parent_id ? "(fork)" : "";
            return `${pin} ${s.id.slice(0, 8)}  ${s.title}  ${formatRelativeTime(s.updated_at)}  ${s.directory} ${fork}`;
          }).join("\n");
        }

        if (a === "session") {
          if (!query) return "Provide a session ID.";
          let s = S.get.get(query) as any;
          if (!s) s = S.getByPrefix.get(`${query}%`) as any;
          if (!s) return `Session ${query} not found.`;
          const fls = S.files.all(s.id) as any[];
          const kids = S.children.all(s.id) as any[];
          const msgCnt = S.messageCount.get(s.id) as any;
          const lines = [
            `Session: ${s.id}`,
            `Title: ${s.title}`,
            `Directory: ${s.directory}`,
            `Project: ${s.project_id}`,
            `Agent: ${s.agent || "unknown"}`,
            `Model: ${s.model || "unknown"}`,
            `Status: ${s.status}`,
            `Messages: ${s.message_count} (recorded: ${msgCnt?.cnt ?? 0})`,
            `Cost: ${formatCost(s.cost)}`,
            `Tokens: ${formatTokens(s.tokens_in)} in / ${formatTokens(s.tokens_out)} out / ${formatTokens(s.tokens_reasoning)} reasoning`,
            `Created: ${new Date(s.created_at).toISOString()}`,
            `Updated: ${formatRelativeTime(s.updated_at)}`,
            `Pinned: ${s.pinned ? "yes" : "no"}`,
          ];
          if (s.parent_id) lines.push(`Forked from: ${s.parent_id}`);
          if (kids.length > 0) {
            lines.push(`Forks (${kids.length}):`);
            kids.forEach((k) => lines.push(`  ${k.id.slice(0, 8)}  ${k.title}  ${formatRelativeTime(k.created_at)}`));
          }
          if (fls.length > 0) {
            lines.push(`Files edited (${fls.length}):`);
            fls.slice(0, 20).forEach((f) => lines.push(`  ${f.path}`));
            if (fls.length > 20) lines.push(`  +${fls.length - 20} more`);
          }
          return lines.join("\n");
        }

        if (a === "messages") {
          if (!query) return "Provide a session ID.";
          const offset = 0;
          let rows = S.messages.all(query, max, offset) as any[];
          if (rows.length === 0) {
            try {
              const r = await client.session.messages({ path: { id: query }, query: { limit: max } });
              if (r.data) return r.data.map((m: any) => {
                const role = m.info?.role ?? "?";
                const pv = extractPreview(m.parts ?? []);
                const age = formatRelativeTime(m.info?.time?.created ?? 0);
                const tools = extractTools(m.parts ?? []);
                const ts = tools.length ? ` [${tools.join(", ")}]` : "";
                const c = m.info?.cost ? ` ${formatCost(m.info.cost)}` : "";
                return `${m.info?.id?.slice(0, 8) ?? "?"} ${role} ${age}${ts}${c}: ${pv}`;
              }).join("\n");
            } catch {}
            return `No messages for session ${query}.`;
          }
          return rows.map((m) => {
            const role = m.role === "user" ? ">" : "<";
            const age = formatRelativeTime(m.created_at);
            const ts = m.tool_calls ? ` [${m.tool_calls}]` : "";
            const c = m.cost ? ` ${formatCost(m.cost)}` : "";
            return `${m.id.slice(0, 8)} ${role} ${age}${ts}${c}: ${m.preview}`;
          }).join("\n");
        }

        if (a === "timeline") {
          if (!query) return "Provide a session ID.";
          const rows = S.timeline.all(query) as any[];
          if (rows.length === 0) return `No timeline for session ${query}.`;
          return rows.map((m, i) => {
            const icon = m.role === "user" ? ">" : "<";
            const age = formatRelativeTime(m.created_at);
            const ts = m.tool_calls ? ` [${m.tool_calls}]` : "";
            const c = m.cost ? ` ${formatCost(m.cost)}` : "";
            return `${String(i + 1).padStart(3)} ${m.id.slice(0, 8)} ${icon} ${age}${ts}${c}: ${m.preview}`;
          }).join("\n");
        }

        if (a === "goto") {
          if (!query) return "Provide a message ID.";
          const m = S.getMsg.get(query) as any;
          if (!m) return `Message ${query} not found.`;
          const nearby = S.msgSeq.all(m.session_id, m.id, 5) as any[];
          const lines = [`Session: ${m.session_id}`, `Message: ${m.id}`, `Role: ${m.role}`, `Time: ${formatRelativeTime(m.created_at)}`, `Preview: ${m.preview}`, "", "Context:"];
          nearby.forEach((n) => {
            const marker = n.id === m.id ? ">>>" : "   ";
            const role = n.role === "user" ? ">" : "<";
            lines.push(`${marker} ${n.id.slice(0, 8)} ${role} ${formatRelativeTime(n.created_at)}: ${n.preview}`);
          });
          lines.push("", "Use 'fork' or 'continue' with this message ID to branch from here.");
          return lines.join("\n");
        }

        if (a === "next" || a === "prev") {
          if (!query) return "Provide a message ID.";
          const m = S.getMsg.get(query) as any;
          if (!m) return `Message ${query} not found.`;
          const stmt = a === "next" ? S.msgNext : S.msgPrev;
          const neighbor = stmt.get(m.session_id, m.id) as any;
          if (!neighbor) return `No ${a} message.`;
          const role = neighbor.role === "user" ? ">" : "<";
          return `${neighbor.id} ${role} ${formatRelativeTime(neighbor.created_at)}: ${neighbor.preview}`;
        }

        if (a === "fork") {
          if (!query) return "Provide a session ID or message ID to fork from.";
          let sid = query;
          let mid: string | undefined;
          const m = S.getMsg.get(query) as any;
          if (m) { sid = m.session_id; mid = m.id; }
          else {
            const s = S.get.get(query) as any;
            if (!s) { const ps = S.getByPrefix.get(`${query}%`) as any; if (!ps) return `Not found: ${query}`; sid = ps.id; }
          }
          try {
            const r = await client.session.fork({ sessionID: sid, ...(mid ? { messageID: mid } : {}) });
            if (r.error) return `Fork failed: ${JSON.stringify(r.error)}`;
            const newId = r.data?.id ?? "unknown";
            try { await client.tui.selectSession({ sessionID: newId }); } catch {}
            return `Forked session ${newId} from ${sid}${mid ? ` at message ${mid}` : ""}. Navigated to new session.`;
          } catch (e: any) { return `Fork failed: ${e.message}`; }
        }

        if (a === "continue") {
          if (!query) return "Provide a session ID to continue in, or 'current' for the active session.";
          const targetSid = query === "current" ? ctx.sessionID : query;
          try {
            await client.tui.selectSession({ sessionID: targetSid });
            await client.tui.appendPrompt({ text: "continue from here" });
            return `Navigated to session ${targetSid}. Prompt pre-filled.`;
          } catch (e: any) { return `Continue failed: ${e.message}`; }
        }

        if (a === "revert") {
          if (!query) return "Provide a message ID to revert to.";
          const m = S.getMsg.get(query) as any;
          if (!m) return `Message ${query} not found.`;
          try {
            const r = await client.session.revert({ sessionID: m.session_id, messageID: m.id });
            if (r.error) return `Revert failed: ${JSON.stringify(r.error)}`;
            try { await client.tui.selectSession({ sessionID: m.session_id }); } catch {}
            return `Reverted session ${m.session_id} to message ${query}. Navigated to session.`;
          } catch (e: any) { return `Revert failed: ${e.message}`; }
        }

        if (a === "rename") {
          if (!query) return "Provide: rename <session-id> <new-title>";
          const parts = query.split(/\s+/);
          const sid = parts[0];
          const title = parts.slice(1).join(" ") || "untitled";
          let realId = sid;
          const s = S.get.get(sid) as any;
          if (!s) { const ps = S.getByPrefix.get(`${sid}%`) as any; if (!ps) return `Session ${sid} not found.`; realId = ps.id; }
          try {
            await client.session.update({ path: { id: realId }, body: { title } });
            S.renameSession.run(title, realId);
            return `Renamed session ${realId.slice(0, 8)} to "${title}".`;
          } catch (e: any) { return `Rename failed: ${e.message}`; }
        }

        if (a === "pin") {
          if (!query) return "Provide a session ID.";
          const s = S.get.get(query) as any ?? S.getByPrefix.get(`${query}%`) as any;
          if (!s) return `Session ${query} not found.`;
          S.pinSession.run(s.id);
          return `Pinned session ${s.id.slice(0, 8)}: ${s.title}`;
        }

        if (a === "unpin") {
          if (!query) return "Provide a session ID.";
          const s = S.get.get(query) as any ?? S.getByPrefix.get(`${query}%`) as any;
          if (!s) return `Session ${query} not found.`;
          S.unpinSession.run(s.id);
          return `Unpinned session ${s.id.slice(0, 8)}: ${s.title}`;
        }

        if (a === "delete") {
          if (!query) return "Provide a session ID.";
          const s = S.get.get(query) as any ?? S.getByPrefix.get(`${query}%`) as any;
          if (!s) return `Session ${query} not found.`;
          try {
            await client.session.delete({ path: { id: s.id } });
            S.deleteSession.run(s.id);
            return `Deleted session ${s.id.slice(0, 8)}: ${s.title}`;
          } catch (e: any) { return `Delete failed: ${e.message}`; }
        }

        if (a === "copy") {
          if (!query) return "Provide a session ID to copy conversation as text.";
          let sid = query;
          const m = S.getMsg.get(query) as any;
          if (m) sid = m.session_id;
          else {
            const s = S.get.get(query) as any ?? S.getByPrefix.get(`${query}%`) as any;
            if (!s) return `Not found: ${query}`;
            sid = s.id;
          }
          try {
            const r = await client.session.messages({ path: { id: sid } });
            if (r.error || !r.data) return `Failed to load session ${sid}.`;
            const text = r.data.map((m: any) => {
              const role = m.info?.role === "user" ? "User" : "Assistant";
              const parts = (m.parts ?? []).map((p: any) => {
                if (p.type === "text") return p.text;
                if (p.type === "tool") {
                  const st = p.state;
                  if (typeof st === "object" && st !== null) {
                    if ("output" in st) return `[${p.tool}]\n${st.output}`;
                    if ("error" in st) return `[${p.tool}] ERROR: ${st.error}`;
                    if ("input" in st) return `[${p.tool}] ${JSON.stringify(st.input, null, 2)}`;
                  }
                  return `[${p.tool}]`;
                }
                if (p.type === "reasoning") return p.text;
                if (p.type === "file") return `[file: ${p.filename ?? p.url}]`;
                return null;
              }).filter(Boolean).join("\n");
              return `## ${role}\n${parts}`;
            }).join("\n\n---\n\n");
            try {
              const clipCmds = [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"], ["wl-copy"], ["pbcopy"]];
              for (const cmd of clipCmds) {
                const r2 = Bun.spawnSync(cmd as any, { stdin: text, stderr: "pipe" });
                if (r2.exitCode === 0) return `Copied ${text.length} chars to clipboard.`;
              }
            } catch {}
            return `Clipboard unavailable. ${text.length} chars. Use 'export' to save to file.`;
          } catch (e: any) { return `Copy failed: ${e.message}`; }
        }

        if (a === "export") {
          if (!query) return "Provide a session ID to export.";
          const s = S.get.get(query) as any ?? S.getByPrefix.get(`${query}%`) as any;
          if (!s) return `Session ${query} not found.`;
          try {
            const r = await client.session.messages({ path: { id: s.id } });
            if (r.error || !r.data) return `Failed to load session ${s.id}.`;
            const md = [`# ${s.title}`, `Session: ${s.id}`, `Date: ${new Date(s.created_at).toISOString()}`, `Model: ${s.model}`, `Agent: ${s.agent}`, `Cost: ${formatCost(s.cost)}`, "", "---", ""];
            for (const m of r.data) {
              const role = m.info?.role === "user" ? "User" : "Assistant";
              md.push(`## ${role}`);
              for (const p of (m.parts ?? [])) {
                if (p.type === "text") md.push(p.text);
                else if (p.type === "tool") {
                  const st = p.state;
                  md.push(`### ${p.tool}`);
                  if (typeof st === "object" && st !== null) {
                    if ("input" in st) md.push("Input:", "```json", JSON.stringify(st.input, null, 2), "```");
                    if ("output" in st) md.push("Output:", String(st.output));
                    if ("error" in st) md.push("Error:", String(st.error));
                  }
                } else if (p.type === "reasoning") md.push(`> ${p.text}`);
                else if (p.type === "file") md.push(`*[file: ${p.filename ?? p.url}]*`);
              }
              md.push("", "---", "");
            }
            const xdgDownload = process.env.XDG_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads");
      const outPath = path.join(xdgDownload, `history-${s.id.slice(0, 8)}.md`);
            await Bun.write(outPath, md.join("\n"));
            return `Exported to ${outPath}`;
          } catch (e: any) { return `Export failed: ${e.message}`; }
        }

        if (a === "projects") {
          const rows = S.projects.all(max) as any[];
          if (rows.length === 0) return "No projects recorded.";
          return rows.map((p) => `${p.cnt} sessions  ${p.directory}`).join("\n");
        }

        if (a === "project") {
          if (!query) return "Provide a project directory.";
          let rows = S.projSessions.all(query, max) as any[];
          if (rows.length === 0) rows = S.projSessionsFuzz.all(`%${query}%`, max) as any[];
          if (rows.length === 0) return `Project ${query} not found.`;
          const d = rows[0].directory;
          const lines = [`Project: ${d}`, `Sessions: ${rows.length}`];
          rows.forEach((s) => lines.push(`  ${s.pinned ? "*" : " "} ${s.id.slice(0, 8)}  ${s.title}  ${formatRelativeTime(s.updated_at)}  ${s.message_count} msgs`));
          return lines.join("\n");
        }

        if (a === "stats") {
          const s = S.stats.get() as any;
          const f = S.fileStats.get() as any;
          return [
            `Sessions: ${s.total_sessions ?? 0}`,
            `Messages: ${s.total_messages ?? 0}`,
            `Cost: ${formatCost(s.total_cost ?? 0)}`,
            `Tokens: ${formatTokens(s.total_in ?? 0)} in / ${formatTokens(s.total_out ?? 0)} out / ${formatTokens(s.total_reasoning ?? 0)} reasoning`,
            `Files edited: ${f.total_files ?? 0}`,
            `Projects: ${s.total_projects ?? 0}`,
          ].join("\n");
        }

        if (a === "activity") {
          const rows = S.dailyCost.all() as any[];
          if (rows.length === 0) return "No activity data.";
          return rows.map((r) => `${r.day}  ${r.sessions} sessions  ${formatCost(r.cost)}  ${formatTokens(r.tokens)} tokens`).join("\n");
        }

        if (a === "models") {
          const rows = S.topModels.all() as any[];
          if (rows.length === 0) return "No model data.";
          return rows.map((r) => `${r.model}  ${r.cnt} sessions  ${formatCost(r.cost)}`).join("\n");
        }

        if (a === "agents") {
          const rows = S.topAgents.all() as any[];
          if (rows.length === 0) return "No agent data.";
          return rows.map((r) => `${r.agent}  ${r.cnt} sessions`).join("\n");
        }

        if (a === "dump") {
          if (!query) return "Provide a session ID.";
          let sid = query;
          const s = S.get.get(query) as any;
          if (!s) { const ps = S.getByPrefix.get(`${query}%`) as any; if (!ps) return `Not found: ${query}`; sid = ps.id; }
          try {
            const r = await client.session.messages({ path: { id: sid } });
            if (r.error || !r.data) return `Failed to load session ${sid}.`;
            return r.data.map((m: any) => {
              const role = m.info?.role ?? "?";
              const parts = (m.parts ?? []).map((p: any) => {
                if (p.type === "text") return p.text;
                if (p.type === "tool") {
                  const st = p.state;
                  if (typeof st === "object" && st !== null) {
                    if ("output" in st) return `[${p.tool}] ${truncate(String(st.output), 300)}`;
                    if ("error" in st) return `[${p.tool}] ERROR: ${truncate(String(st.error), 150)}`;
                    if ("input" in st) return `[${p.tool}] ${truncate(JSON.stringify(st.input), 150)}`;
                  }
                  return `[${p.tool}]`;
                }
                if (p.type === "reasoning") return truncate(p.text, 200);
                if (p.type === "file") return `[file: ${p.filename ?? p.url}]`;
                return null;
              }).filter(Boolean).join("\n");
              const c = m.info?.cost ? ` (cost: ${formatCost(m.info.cost)})` : "";
              return `--- ${role}${c} ---\n${parts}`;
            }).join("\n\n");
          } catch { return `Failed to dump session ${sid}.`; }
        }

        return `Unknown action: ${a}`;
      },
    });

    return {
      tool: { history: historyTool },

      event: async ({ event }: { event: any }) => {
        const type = event.type;

        if (type === "session.created" || type === "session.updated") {
          const info = event.properties?.info;
          if (info) upsertSession(info);
          return;
        }

        if (type === "session.deleted") {
          const info = event.properties?.info;
          if (info) S.deleteSession.run(info.id);
          return;
        }

        if (type === "session.status") {
          const { sessionID, status } = event.properties ?? {};
          if (sessionID) S.setStatus.run(status?.type ?? "idle", sessionID);
          return;
        }

        if (type === "message.updated") {
          const info = event.properties?.info;
          if (!info) return;
          const sid = info.sessionID;
          const role = info.role;

          if (role === "user") {
            S.incSession.run(Date.now(), 0, 0, 0, 0,
              info.model ? `${info.model.providerID}/${info.model.modelID}` : "",
              info.agent ?? "", sid);
          } else if (role === "assistant") {
            S.incSession.run(Date.now(),
              info.cost ?? 0, info.tokens?.input ?? 0, info.tokens?.output ?? 0, info.tokens?.reasoning ?? 0,
              info.modelID ? `${info.providerID}/${info.modelID}` : "", "", sid);

            S.insertMsg.run(info.id, sid, "assistant", info.time?.created ?? Date.now(),
              "", `${info.providerID ?? ""}/${info.modelID ?? ""}`,
              info.cost ?? 0, info.tokens?.input ?? 0, info.tokens?.output ?? 0, info.tokens?.reasoning ?? 0,
              "", 0, info.parentID ?? "");
          }
          return;
        }

        if (type === "message.part.updated") {
          const part = event.properties?.part;
          if (!part || !part.sessionID || !part.messageID) return;
          if (part.type === "text" && part.text) {
            S.insertMsg.run(part.messageID, part.sessionID, "user",
              part.time?.start ?? Date.now(), truncate(part.text, maxMessagePreview),
              "", 0, 0, 0, 0, "", 0, "");
          }
          if (part.type === "tool" && part.tool) {
            const st = part.state;
            let preview = "";
            if (typeof st === "object" && st !== null) {
              if ("output" in st) preview = truncate(String(st.output), maxMessagePreview);
              else if ("error" in st) preview = `ERROR: ${truncate(String(st.error), 60)}`;
              else if ("input" in st) preview = truncate(JSON.stringify(st.input), 60);
            }
            S.insertMsg.run(`${part.messageID}_${part.tool}`, part.sessionID, "tool",
              Date.now(), preview, "", 0, 0, 0, 0, part.tool, 0, "");
          }
          return;
        }

        if (type === "file.edited") {
          const { sessionID } = event.properties ?? {};
          const file = event.properties?.file;
          if (sessionID && file) S.insertFile.run(sessionID, file);
          return;
        }
      },
    };
  },
};

export default HistoryPlugin;
