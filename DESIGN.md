# Channel: design

A WhatsApp-style app for your AI agents. You add agents, chat with one, several, or a group, and stay in
control of what they pass to each other. Written 13 November 2026, before any code.

## What it does (version 1)

- **Agents list.** Add an agent by its address. The app reads the agent's card and shows its name and what it can do.
- **Chats.** A one-to-one chat with any agent, or a group with several. You are always in the group.
- **Talking to a group.** Type `@Hermes` to address one agent, `@all` for everyone. With no mention, the
  message goes to everyone in a group of two or fewer agents, and to nobody in a bigger group (the app asks you to pick).
- **Agents talking to each other.** When an agent's reply mentions another agent ("@OpenClaw, can you book
  it?"), the app does not forward it on its own. It shows a hand-off card: *Hermes wants to send this to
  OpenClaw* with **Send**, **Edit** and **Skip**. You decide.
- **Auto mode** (off by default, per group). Hand-offs go through on their own, up to a limit of hops for each
  message you send (default 4). A **Stop** button ends a running exchange at once.

## How it works (in plain words)

```
 You (browser)  <-->  Channel server (on this Mac)  <-->  Hermes      (A2A, port 9900)
                                                   <-->  OpenClaw    (A2A, port 18789)
                                                   <-->  test agents (A2A, for tests)
```

- **The browser never talks to an agent directly.** It talks only to the Channel server running on this Mac.
  The server holds each agent's access token and makes the calls. Hermes also refuses requests that come
  from a web page, so this is required, not just tidier.
- **A2A** is the shared language: the server sends `SendMessage` with your text and gets back the agent's
  reply, either at once or as a task it checks on (`GetTask`) until it finishes.
- **Each chat has its own thread on each agent.** A2A calls this a `contextId`. The agent keeps its own memory
  of the thread, so the server sends only what the agent has not seen yet, each line labelled with who said it
  (`[You]`, `[OpenClaw]`).
- **Privacy rule: an agent only receives what was meant for it.** That is your messages addressed to it (by
  @mention, @all, or by default in a group of two), and another agent's message when you approve a hand-off.
  An agent's answer to you is never passed to another agent by itself, even in a group. (Found by a test on
  13 November: the first version passed everything to everyone.)
- **Messages from other agents are marked as such.** An agent is told plainly that a line came from another
  agent, not from you, so it does not treat it as your instruction.
- **Storage.** Chats and messages are kept in a small database file on this Mac (`data/channel.db`). Agent
  tokens are kept in `data/agents.json`. Both stay on this Mac and out of git.
- **The server only listens on this Mac** (`127.0.0.1`). Nothing is reachable from the internet.

## Loop control

Two agents can answer each other forever. Four guards stop that:

1. Hand-offs need your approval (default).
2. In auto mode, a hop limit per message you send (default 4, maximum 10).
3. The same message is never forwarded twice.
4. A Stop button. Hermes also has its own cap of 5 back-and-forth turns per thread.

## What the app can and cannot control

- **It controls what is sent between agents.** Nothing from one agent reaches another without your approval,
  unless you turn on auto mode for that group.
- **It cannot control what an agent does with its own tools.** If Hermes can spend money or run commands on
  this Mac, that happens inside Hermes and follows Hermes's own approval settings. Channel cannot see or stop it.
  This is stated in the app next to each agent.

## Which agents can join (checked 13 November 2026)

| Agent | Can join | How |
|---|---|---|
| Hermes (Nous Research) | Yes | Its A2A door, with a token for Channel |
| OpenClaw | Yes, from version 2026.11.x | Its A2A door, with a token for Channel |
| Dots (OpenAI) | Later | Only inside Slack |
| Muse (Meta) | Later | Only as a connector Muse can call, after Meta approves it |
| Hark, Instinct, Claude Duet | No | Their terms forbid automated access |

## Tests

- Two test agents that speak A2A and answer from a script, with no AI model and no cost. They let every part of
  the app (routing, hand-offs, hop limits, Stop, errors, slow tasks) be tested without your real agents.
- The real demo with Hermes and OpenClaw comes last.

## Technology

Node 22 and TypeScript. Server: Hono (a small web server library). Database: SQLite, built into Node. Screen:
React with Vite. Live updates from server to screen: server-sent events (one open connection the server
writes to). Chosen for being small, common and easy to read.

## Not in version 1

Dashboards, analytics, your own orchestrator, the agent store, phones. They come after people use this.
