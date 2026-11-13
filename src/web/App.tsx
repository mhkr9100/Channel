import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Agent, type Chat, type HandoffMeta, type Message } from "./api.ts";

const PALETTE = ["#2563eb", "#9333ea", "#db2777", "#ea580c", "#0d9488", "#65a30d", "#0891b2", "#c026d3"];
const colorFor = (id: string) => PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length]!;
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<"agents" | "new" | null>(null);
  const [connected, setConnected] = useState(false);
  const activeRef = useRef<number | null>(null);
  activeRef.current = activeId;

  const loadAgents = useCallback(() => api.agents().then(setAgents).catch(() => {}), []);
  const loadChats = useCallback(() => api.chats().then(setChats).catch(() => {}), []);

  useEffect(() => { loadAgents(); loadChats(); }, [loadAgents, loadChats]);

  useEffect(() => {
    setMessages([]); // never show the previous chat's messages while this one loads
    if (activeId == null) return;
    setTyping({});
    api.messages(activeId).then(setMessages).catch(() => setMessages([]));
  }, [activeId]);

  // Live updates from the server.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("ready", () => setConnected(true));
    es.onerror = () => setConnected(false);
    const parse = (e: MessageEvent) => JSON.parse(e.data);
    es.addEventListener("message", (e) => {
      const ev = parse(e as MessageEvent);
      if (ev.chatId === activeRef.current) setMessages((ms) => (ms.some((m) => m.id === ev.message.id) ? ms : [...ms, ev.message]));
    });
    es.addEventListener("message-updated", (e) => {
      const ev = parse(e as MessageEvent);
      if (ev.chatId === activeRef.current) setMessages((ms) => ms.map((m) => (m.id === ev.message.id ? ev.message : m)));
    });
    es.addEventListener("typing", (e) => {
      const ev = parse(e as MessageEvent);
      if (ev.chatId === activeRef.current) setTyping((t) => ({ ...t, [ev.agentId]: ev.on }));
    });
    es.addEventListener("chats", () => loadChats());
    es.addEventListener("agents", () => loadAgents());
    return () => es.close();
  }, [loadAgents, loadChats]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const active = chats.find((c) => c.id === activeId) ?? null;

  return (
    <div className="app">
      <aside className={`sidebar ${activeId != null ? "has-active" : ""}`}>
        <header className="sidebar-head">
          <div className="brand"><span className="logo">◎</span> Channel</div>
          <div className="head-actions">
            <button className="ghost" onClick={() => setPanel("agents")} title="Your agents">Agents</button>
            <button className="primary" onClick={() => setPanel("new")} disabled={!agents.length} title={agents.length ? "Start a chat" : "Add an agent first"}>New chat</button>
          </div>
        </header>
        {!connected && <div className="banner warn">Not connected to the Channel server. Is it running?</div>}
        <ul className="chat-list">
          {chats.length === 0 && (
            <li className="empty-list">
              {agents.length ? "No chats yet. Start one with New chat." : "Add your first agent under Agents, then start a chat."}
            </li>
          )}
          {chats.map((c) => (
            <li key={c.id}>
              <button className={`chat-item ${c.id === activeId ? "active" : ""}`} onClick={() => setActiveId(c.id)}>
                <Avatars ids={c.agentIds} agentById={agentById} />
                <span className="chat-item-text">
                  <span className="chat-item-title">{c.title}</span>
                  <span className="chat-item-last">{c.last ? preview(c.last, agentById) : c.kind === "group" ? "Group" : "Direct chat"}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        {active ? (
          <ChatView key={active.id} chat={active} messages={messages} typing={typing} agentById={agentById} onBack={() => setActiveId(null)} />
        ) : (
          <div className="placeholder">
            <h1>Your agents, in one place</h1>
            <p>Chat with one agent, or put several in a group. When an agent wants to pass something to another, you decide.</p>
            {!agents.length && <button className="primary" onClick={() => setPanel("agents")}>Add an agent</button>}
          </div>
        )}
      </main>

      {panel === "agents" && <AgentsPanel agents={agents} onClose={() => setPanel(null)} />}
      {panel === "new" && <NewChatPanel agents={agents} onClose={() => setPanel(null)} onCreated={(id) => { setPanel(null); setActiveId(id); }} />}
    </div>
  );
}

function preview(m: Message, agentById: Map<string, Agent>) {
  const who = m.author === "you" ? "You" : m.author === "channel" ? "" : agentById.get(m.author)?.name ?? m.author;
  const text = m.kind === "handoff" ? m.text : m.text.replace(/\s+/g, " ");
  return (who ? `${who}: ` : "") + (text.length > 60 ? text.slice(0, 60) + "…" : text);
}

function Avatars({ ids, agentById }: { ids: string[]; agentById: Map<string, Agent> }) {
  return (
    <span className="avatars">
      {ids.slice(0, 3).map((id) => (
        <span key={id} className="avatar" style={{ background: colorFor(id) }} title={agentById.get(id)?.name ?? id}>
          {initials(agentById.get(id)?.name ?? id)}
        </span>
      ))}
    </span>
  );
}

function ChatView({ chat, messages, typing, agentById, onBack }: {
  chat: Chat; messages: Message[]; typing: Record<string, boolean>; agentById: Map<string, Agent>; onBack: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [hopLimit, setHopLimit] = useState(chat.hopLimit);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const members = chat.agentIds.map((id) => agentById.get(id)).filter((a): a is Agent => !!a);
  const working = Object.entries(typing).filter(([, on]) => on).map(([id]) => agentById.get(id)?.name ?? id);
  const pending = messages.some((m) => m.kind === "handoff" && (m.meta as HandoffMeta).status === "pending");
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // Jump to the newest message when a chat opens; scroll smoothly for messages that arrive after that.
  const seen = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: seen.current === 0 ? "auto" : "smooth" });
    seen.current = messages.length;
  }, [messages.length, working.length]);
  useEffect(() => { setHopLimit(chat.hopLimit); }, [chat.hopLimit]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setError("");
    setText("");
    try { await api.send(chat.id, t); } catch (e) { setError((e as Error).message); setText(t); }
  };
  const mention = (id: string) => {
    setText((t) => (t && !t.endsWith(" ") ? t + " " : t) + `@${id} `);
    input.current?.focus();
  };

  return (
    <section className="chat">
      <header className="chat-head">
        <button className="ghost back" onClick={onBack} aria-label="Back to chats">‹</button>
        <Avatars ids={chat.agentIds} agentById={agentById} />
        <div className="chat-head-text">
          <h2>{chat.title}</h2>
          <span className="sub">{members.map((m) => m.name).join(", ")}{chat.kind === "group" ? " and you" : ""}</span>
        </div>
        {chat.kind === "group" && (
          <div className="chat-controls">
            <label className="toggle" title="When on, agents pass messages to each other without asking you, up to the hop limit">
              <input type="checkbox" checked={chat.auto} onChange={(e) => api.updateChat(chat.id, { auto: e.target.checked })} />
              <span>Auto hand-offs</span>
            </label>
            <label className="hop" title="Most hand-offs between agents for one message of yours">
              Limit
              <input type="number" min={1} max={10} value={hopLimit} onChange={(e) => setHopLimit(Number(e.target.value))} onBlur={() => api.updateChat(chat.id, { hopLimit })} />
            </label>
          </div>
        )}
        <button className="danger" onClick={() => api.stop(chat.id)} disabled={!working.length && !pending} title="Stop everything running in this chat">Stop</button>
      </header>

      <div className="messages" ref={scroller}>
        {messages.length === 0 && (
          <p className="hint">
            {chat.kind === "group"
              ? `Type @ and a name to address one agent, or @all. ${members.length <= 2 ? "With no mention, both agents answer." : "With no mention, nobody is asked."}`
              : `Say hello to ${members[0]?.name ?? "your agent"}.`}
          </p>
        )}
        {messages.map((m) => <MessageRow key={m.id} m={m} byId={byId} agentById={agentById} />)}
        {working.length > 0 && <div className="working">{working.join(", ")} {working.length > 1 ? "are" : "is"} working…</div>}
      </div>

      <footer className="composer">
        {chat.kind === "group" && (
          <div className="mention-chips">
            {members.map((a) => <button key={a.id} className="chip" style={{ borderColor: colorFor(a.id), color: colorFor(a.id) }} onClick={() => mention(a.id)}>@{a.id}</button>)}
            <button className="chip" onClick={() => mention("all")}>@all</button>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="composer-row">
          <textarea
            ref={input}
            value={text}
            placeholder={chat.kind === "group" ? "Message the group…" : `Message ${members[0]?.name ?? ""}…`}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="primary send" onClick={send} disabled={!text.trim()}>Send</button>
        </div>
      </footer>
    </section>
  );
}

function MessageRow({ m, byId, agentById }: { m: Message; byId: Map<number, Message>; agentById: Map<string, Agent> }) {
  if (m.kind === "notice") return <div className="notice">{m.text}</div>;
  if (m.kind === "handoff") return <HandoffCard m={m} source={byId.get((m.meta as HandoffMeta).sourceId)} agentById={agentById} />;
  const mine = m.author === "you";
  const agent = agentById.get(m.author);
  return (
    <div className={`row ${mine ? "mine" : ""}`}>
      <div className={`bubble ${m.kind === "error" ? "error" : ""}`} style={!mine ? { borderLeftColor: colorFor(m.author) } : undefined}>
        {!mine && <div className="author" style={{ color: colorFor(m.author) }}>{agent?.name ?? m.author}{m.hop > 0 ? <span className="hop-tag">hand-off {m.hop}</span> : null}</div>}
        <div className="text">{m.kind === "error" ? `Could not get an answer. ${m.text}` : m.text}</div>
        <div className="time">{time(m.createdAt)}</div>
      </div>
    </div>
  );
}

function HandoffCard({ m, source, agentById }: { m: Message; source: Message | undefined; agentById: Map<string, Agent> }) {
  const meta = m.meta as HandoffMeta;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const from = agentById.get(meta.from)?.name ?? meta.from;
  const to = agentById.get(meta.to)?.name ?? meta.to;
  const act = async (action: "send" | "skip", t?: string) => {
    setBusy(true); setError("");
    try { await api.handoff(m.id, action, t); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className={`handoff ${meta.status}`}>
      <div className="handoff-title">
        <span className="dot" style={{ background: colorFor(meta.from) }} /> {from} → <span className="dot" style={{ background: colorFor(meta.to) }} /> {to}
        <span className={`status ${meta.status}`}>{meta.status === "pending" ? "Waiting for you" : meta.status === "sent" ? (meta.editedText ? "Sent, edited" : "Sent") : "Skipped"}</span>
      </div>
      {meta.status === "pending" && (
        <>
          <p className="handoff-q">{from} wants to pass this to {to}. Only what you send here reaches {to}.</p>
          {editing ? (
            <textarea className="handoff-edit" value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
          ) : (
            <blockquote>{source?.text ?? "(message not found)"}</blockquote>
          )}
          {error && <div className="banner error">{error}</div>}
          <div className="handoff-actions">
            {editing ? (
              <>
                <button className="primary" disabled={busy || !draft.trim()} onClick={() => act("send", draft)}>Send edited</button>
                <button className="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
              </>
            ) : (
              <>
                <button className="primary" disabled={busy} onClick={() => act("send")}>Send to {to}</button>
                <button className="ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
                <button className="ghost" disabled={busy} onClick={() => act("skip")}>Skip</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h3>{title}</h3><button className="ghost" onClick={onClose} aria-label="Close">✕</button></header>
        {children}
      </div>
    </div>
  );
}

function AgentsPanel({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    setBusy(true); setError("");
    try { await api.addAgent(url.trim(), token.trim(), handle.trim()); setUrl(""); setToken(""); setHandle(""); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Your agents" onClose={onClose}>
      <ul className="agent-list">
        {agents.length === 0 && <li className="empty-list">No agents yet.</li>}
        {agents.map((a) => (
          <li key={a.id} className="agent-row">
            <span className="avatar" style={{ background: colorFor(a.id) }}>{initials(a.name)}</span>
            <span className="agent-text">
              <strong>{a.name}</strong> <span className="muted">@{a.id}</span>
              <span className="muted small">{a.baseUrl}{a.hasToken ? " · token saved" : " · no token"}</span>
              {a.skills.length > 0 && <span className="muted small">Can: {a.skills.slice(0, 6).join(", ")}{a.skills.length > 6 ? "…" : ""}</span>}
            </span>
            <button className="ghost" onClick={() => { if (confirm(`Remove ${a.name}? Its chats lose this member.`)) api.removeAgent(a.id); }}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="form">
        <h4>Add an agent</h4>
        <label>Address<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:9900" /></label>
        <label>Access token<input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="The token you gave this agent for Channel" autoComplete="off" /></label>
        <label>Name to mention (optional)<input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="Taken from the agent's card if empty" /></label>
        {error && <div className="banner error">{error}</div>}
        <button className="primary" onClick={add} disabled={busy || !url.trim()}>{busy ? "Checking…" : "Add agent"}</button>
        <p className="muted small">The token stays on this Mac, in Channel's data folder. Channel controls what passes between agents; what each agent does with its own tools follows that agent's own settings.</p>
      </div>
    </Modal>
  );
}

function NewChatPanel({ agents, onClose, onCreated }: { agents: Agent[]; onClose: () => void; onCreated: (id: number) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const create = async () => {
    try { const c = await api.createChat(title, picked); onCreated(c.id); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal title="New chat" onClose={onClose}>
      <p className="muted small">Pick one agent for a direct chat, or several for a group.</p>
      <ul className="agent-list pick">
        {agents.map((a) => (
          <li key={a.id}>
            <label className="agent-row">
              <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} />
              <span className="avatar" style={{ background: colorFor(a.id) }}>{initials(a.name)}</span>
              <span className="agent-text"><strong>{a.name}</strong> <span className="muted">@{a.id}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {picked.length > 1 && <label className="form-line">Group name<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Weekend plans" /></label>}
      {error && <div className="banner error">{error}</div>}
      <button className="primary" onClick={create} disabled={!picked.length}>{picked.length > 1 ? "Create group" : "Start chat"}</button>
    </Modal>
  );
}
