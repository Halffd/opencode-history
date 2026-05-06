#!/usr/bin/env python3
import sqlite3
import sys
import os
import argparse
import json
from datetime import datetime, timezone

DB_PATH = os.path.expanduser("~/.local/share/opencode/history/history.db")

def ts_to_str(ts):
    if not ts:
        return "unknown"
    try:
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        diff = datetime.now(tz=timezone.utc) - dt
        s = int(diff.total_seconds())
        if s < 60: return f"{s}s ago"
        m = s // 60
        if m < 60: return f"{m}m ago"
        h = m // 60
        if h < 24: return f"{h}h ago"
        d = h // 24
        if d < 30: return f"{d}d ago"
        return dt.strftime("%Y-%m-%d")
    except:
        return str(ts)

def fmt_cost(c):
    if c < 0.01: return "$0.00"
    return f"${c:.2f}"

def fmt_tokens(n):
    if n < 1000: return str(n)
    if n < 1_000_000: return f"{n/1000:.1f}k"
    return f"{n/1_000_000:.1f}M"

def get_db(path):
    if not os.path.exists(path):
        print(f"Database not found: {path}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def cmd_recent(args):
    db = get_db(args.db)
    cur = db.cursor()
    limit = args.limit or 20
    cur.execute("SELECT * FROM sessions WHERE pinned=1 ORDER BY updated_at DESC")
    pinned = cur.fetchall()
    cur.execute("SELECT * FROM sessions WHERE pinned=0 ORDER BY updated_at DESC LIMIT ?", (limit,))
    rows = pinned + cur.fetchall()
    if not rows:
        print("No sessions."); return
    for r in rows:
        pin = "*" if r["pinned"] else " "
        age = ts_to_str(r["updated_at"])
        msgs = f'{r["message_count"]} msgs' if r["message_count"] else ""
        cost = fmt_cost(r["cost"])
        fork = "(fork)" if r["parent_id"] else ""
        meta = " | ".join(filter(None, [msgs, cost, r["model"], r["agent"], fork]))
        print(f'{pin} {r["id"][:8]}  {r["title"]}  {age}  {meta}')
    db.close()

def cmd_search(args):
    db = get_db(args.db)
    pat = f"%{args.query}%"
    cur = db.cursor()
    cur.execute("SELECT * FROM sessions WHERE title LIKE ? OR directory LIKE ? OR model LIKE ? OR agent LIKE ? ORDER BY updated_at DESC LIMIT ?",
                (pat, pat, pat, pat, args.limit or 20))
    rows = cur.fetchall()
    cur.execute("SELECT s.* FROM sessions s JOIN files f ON s.id=f.session_id WHERE f.path LIKE ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?",
                (pat, args.limit or 20))
    file_rows = cur.fetchall()
    seen = {r["id"] for r in rows}
    for r in file_rows:
        if r["id"] not in seen: rows.append(r); seen.add(r["id"])
    if not rows:
        print(f'No sessions matching "{args.query}".'); return
    for r in rows:
        pin = "*" if r["pinned"] else " "
        fork = "(fork)" if r["parent_id"] else ""
        print(f'{pin} {r["id"][:8]}  {r["title"]}  {ts_to_str(r["updated_at"])}  {r["directory"]} {fork}')
    db.close()

def cmd_session(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT * FROM sessions WHERE id=? OR id LIKE ?", (args.id, f"{args.id}%"))
    s = cur.fetchone()
    if not s:
        print(f"Session {args.id} not found."); return
    cur.execute("SELECT path FROM files WHERE session_id=? ORDER BY path", (s["id"],))
    files = cur.fetchall()
    cur.execute("SELECT * FROM sessions WHERE parent_id=? ORDER BY created_at", (s["id"],))
    kids = cur.fetchall()
    cur.execute("SELECT COUNT(*) as cnt FROM messages WHERE session_id=?", (s["id"],))
    msg_cnt = cur.fetchone()["cnt"]
    lines = [
        f"Session: {s['id']}",
        f"Title: {s['title']}",
        f"Directory: {s['directory']}",
        f"Project: {s['project_id']}",
        f"Agent: {s['agent'] or 'unknown'}",
        f"Model: {s['model'] or 'unknown'}",
        f"Status: {s['status']}",
        f"Messages: {s['message_count']} (recorded: {msg_cnt})",
        f"Cost: {fmt_cost(s['cost'])}",
        f"Tokens: {fmt_tokens(s['tokens_in'])} in / {fmt_tokens(s['tokens_out'])} out / {fmt_tokens(s['tokens_reasoning'])} reasoning",
        f"Created: {datetime.fromtimestamp(s['created_at']/1000, tz=timezone.utc).isoformat()}",
        f"Updated: {ts_to_str(s['updated_at'])}",
        f"Pinned: {'yes' if s['pinned'] else 'no'}",
    ]
    if s["parent_id"]: lines.append(f"Forked from: {s['parent_id']}")
    if kids:
        lines.append(f"Forks ({len(kids)}):")
        for k in kids: lines.append(f"  {k['id'][:8]}  {k['title']}  {ts_to_str(k['created_at'])}")
    if files:
        lines.append(f"Files edited ({len(files)}):")
        for i, f in enumerate(files[:20]): lines.append(f"  {f['path']}")
        if len(files) > 20: lines.append(f"  +{len(files)-20} more")
    print("\n".join(lines))
    db.close()

def cmd_messages(args):
    db = get_db(args.db)
    cur = db.cursor()
    limit = args.limit or 50
    offset = getattr(args, "offset", 0) or 0
    cur.execute("SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT ? OFFSET ?",
                (args.id, limit, offset))
    rows = cur.fetchall()
    if not rows:
        print(f"No messages for session {args.id}."); return
    for m in rows:
        role = ">" if m["role"] == "user" else "<" if m["role"] == "assistant" else "-"
        age = ts_to_str(m["created_at"])
        ts = f' [{m["tool_calls"]}]' if m["tool_calls"] else ""
        c = f' {fmt_cost(m["cost"])}' if m["cost"] else ""
        print(f'{m["id"][:8]} {role} {age}{ts}{c}: {m["preview"]}')
    db.close()

def cmd_timeline(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT id, session_id, role, created_at, preview, tool_calls, cost FROM messages WHERE session_id=? ORDER BY created_at ASC", (args.id,))
    rows = cur.fetchall()
    if not rows:
        print(f"No timeline for session {args.id}."); return
    for i, m in enumerate(rows):
        icon = ">" if m["role"] == "user" else "<"
        age = ts_to_str(m["created_at"])
        ts = f' [{m["tool_calls"]}]' if m["tool_calls"] else ""
        c = f' {fmt_cost(m["cost"])}' if m["cost"] else ""
        print(f'{str(i+1).rjust(3)} {m["id"][:8]} {icon} {age}{ts}{c}: {m["preview"]}')
    db.close()

def cmd_stats(args):
    db = get_db(args.db)
    cur = db.cursor()
    s = cur.execute("SELECT COUNT(*) as total_sessions, COALESCE(SUM(message_count),0) as total_messages, COALESCE(SUM(cost),0) as total_cost, COALESCE(SUM(tokens_in),0) as total_in, COALESCE(SUM(tokens_out),0) as total_out, COALESCE(SUM(tokens_reasoning),0) as total_reasoning, COUNT(DISTINCT directory) as total_projects FROM sessions").fetchone()
    f = cur.execute("SELECT COUNT(DISTINCT path) as total_files FROM files").fetchone()
    print(f"Sessions: {s['total_sessions']}")
    print(f"Messages: {s['total_messages']}")
    print(f"Cost: {fmt_cost(s['total_cost'])}")
    print(f"Tokens: {fmt_tokens(s['total_in'])} in / {fmt_tokens(s['total_out'])} out / {fmt_tokens(s['total_reasoning'])} reasoning")
    print(f"Files edited: {f['total_files']}")
    print(f"Projects: {s['total_projects']}")
    db.close()

def cmd_activity(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT date(updated_at/1000, 'unixepoch') as day, COUNT(*) as sessions, SUM(cost) as cost, SUM(tokens_in+tokens_out+tokens_reasoning) as tokens FROM sessions GROUP BY day ORDER BY day DESC LIMIT 14")
    rows = cur.fetchall()
    if not rows: print("No activity data."); return
    for r in rows:
        print(f"{r['day']}  {r['sessions']} sessions  {fmt_cost(r['cost'])}  {fmt_tokens(r['tokens'])} tokens")
    db.close()

def cmd_models(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT model, COUNT(*) as cnt, SUM(cost) as cost FROM sessions WHERE model!='' GROUP BY model ORDER BY cnt DESC LIMIT 5")
    for r in cur.fetchall(): print(f"{r['model']}  {r['cnt']} sessions  {fmt_cost(r['cost'])}")
    db.close()

def cmd_agents(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT agent, COUNT(*) as cnt FROM sessions WHERE agent!='' GROUP BY agent ORDER BY cnt DESC LIMIT 5")
    for r in cur.fetchall(): print(f"{r['agent']}  {r['cnt']} sessions")
    db.close()

def cmd_projects(args):
    db = get_db(args.db)
    cur = db.cursor()
    limit = args.limit or 20
    cur.execute("SELECT directory, COUNT(*) as cnt FROM sessions WHERE directory!='' GROUP BY directory ORDER BY cnt DESC LIMIT ?", (limit,))
    rows = cur.fetchall()
    if not rows: print("No projects."); return
    for r in rows: print(f"{r['cnt']} sessions  {r['directory']}")
    db.close()

def cmd_project(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT * FROM sessions WHERE directory=? ORDER BY updated_at DESC LIMIT 20", (args.dir,))
    rows = cur.fetchall()
    if not rows:
        cur.execute("SELECT * FROM sessions WHERE directory LIKE ? ORDER BY updated_at DESC LIMIT 20", (f"%{args.dir}%",))
        rows = cur.fetchall()
    if not rows: print(f"Project {args.dir} not found."); return
    d = rows[0]["directory"]
    print(f"Project: {d}")
    print(f"Sessions: {len(rows)}")
    for s in rows:
        pin = "*" if s["pinned"] else " "
        print(f'  {pin} {s["id"][:8]}  {s["title"]}  {ts_to_str(s["updated_at"])}  {s["message_count"]} msgs')
    db.close()

def cmd_pinned(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT * FROM sessions WHERE pinned=1 ORDER BY updated_at DESC")
    rows = cur.fetchall()
    if not rows: print("No pinned sessions."); return
    for s in rows: print(f'* {s["id"][:8]}  {s["title"]}  {ts_to_str(s["updated_at"])}')
    db.close()

def cmd_files(args):
    db = get_db(args.db)
    cur = db.cursor()
    cur.execute("SELECT session_id, path FROM files WHERE session_id=? OR session_id LIKE ? ORDER BY path", (args.id, f"{args.id}%"))
    rows = cur.fetchall()
    if not rows: print(f"No files for session {args.id}."); return
    for r in rows: print(f'  {r["path"]}')
    db.close()

def cmd_json(args):
    db = get_db(args.db)
    cur = db.cursor()
    data = {"sessions": [], "messages": [], "files": []}
    cur.execute("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", (args.limit or 50,))
    for r in cur.fetchall(): data["sessions"].append(dict(r))
    if args.id:
        cur.execute("SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT ?", (args.id, args.limit or 200))
        for r in cur.fetchall(): data["messages"].append(dict(r))
        cur.execute("SELECT * FROM files WHERE session_id=?", (args.id,))
        for r in cur.fetchall(): data["files"].append(dict(r))
    print(json.dumps(data, indent=2, default=str))
    db.close()

def main():
    p = argparse.ArgumentParser(prog="opencode-history", description="Read opencode-history SQLite database")
    p.add_argument("--db", default=DB_PATH, help=f"Path to history.db (default: {DB_PATH})")
    p.add_argument("--limit", "-n", type=int, default=None, help="Max results")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("recent", help="List recent sessions")
    sub.add_parser("pinned", help="List pinned sessions")
    s = sub.add_parser("search", help="Search sessions"); s.add_argument("query")
    s = sub.add_parser("session", help="Session details"); s.add_argument("id")
    s = sub.add_parser("messages", help="Message log"); s.add_argument("id"); s.add_argument("--offset", type=int, default=0)
    s = sub.add_parser("timeline", help="Chronological timeline"); s.add_argument("id")
    s = sub.add_parser("files", help="Files edited in session"); s.add_argument("id")
    sub.add_parser("stats", help="Aggregate statistics")
    sub.add_parser("activity", help="Daily cost/token breakdown")
    sub.add_parser("models", help="Top models")
    sub.add_parser("agents", help="Top agents")
    sub.add_parser("projects", help="List projects")
    s = sub.add_parser("project", help="Sessions for a project"); s.add_argument("dir")
    s = sub.add_parser("json", help="Export as JSON"); s.add_argument("id", nargs="?", default=None)

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        sys.exit(0)

    cmds = {
        "recent": cmd_recent, "pinned": cmd_pinned, "search": cmd_search,
        "session": cmd_session, "messages": cmd_messages, "timeline": cmd_timeline,
        "stats": cmd_stats, "activity": cmd_activity, "models": cmd_models,
        "agents": cmd_agents, "projects": cmd_projects, "project": cmd_project,
        "files": cmd_files, "json": cmd_json,
    }
    fn = cmds.get(args.cmd)
    if fn:
        fn(args)
    else:
        p.print_help()

if __name__ == "__main__":
    main()
