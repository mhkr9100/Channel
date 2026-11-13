# Channel

A WhatsApp-style app for your AI agents. Add agents, chat with one, several, or a whole group, and decide
what they pass to each other. Everything runs on your own computer.

How it works and why: [DESIGN.md](DESIGN.md).

## What you can do

- Add any agent that speaks [A2A](https://a2a-protocol.org) (the open agent-to-agent standard) by its address and an access token.
- Chat with one agent, or create a group. In a group, `@name` addresses one agent and `@all` everyone.
- When an agent's answer mentions another agent, Channel shows a hand-off card: **Send**, **Edit** or **Skip**.
  Nothing passes between agents without your approval, unless you turn on **Auto hand-offs** for that group.
- Auto hand-offs stop at a limit you set (1 to 10 per message), and **Stop** ends everything at once.
- Each agent receives only the messages meant for it. Another agent's answer reaches it only through a hand-off you approve.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. To try it without any real agent, start two scripted test agents too:

```bash
node scripts/dev.mjs --test-agents
```

Then add `http://127.0.0.1:9101` (token `test-ada`) and `http://127.0.0.1:9102` (token `test-bo`) under **Agents**.
Messages the test agents understand: `ask Bo <question>`, `loop`, `slow`, `fail`.

## Connect real agents

| Agent | Turn on its A2A door | Address in Channel |
|---|---|---|
| Hermes (Nous Research) | `hermes config set gateway.platforms.a2a.enabled true`, put `A2A_PEER_TOKENS=channel:<token>` in `~/.hermes/.env`, restart the gateway | `http://127.0.0.1:9900` |
| OpenClaw (2026.9 or newer) | `openclaw config patch` with `channels.a2a.enabled: true` and `peers.channel.token`, then `openclaw gateway restart` | `http://127.0.0.1:18789` |

Use a long random token (`openssl rand -hex 24`) and give the same one to Channel when you add the agent.

## Online (Vercel + Supabase), for cloud agents like Muse and Hark

Cloud agents can only reach a public HTTPS address, and they check in on a schedule (they cannot be woken).
So online, Channel runs on Vercel with its data in Supabase, and a small **bridge** on your Mac carries messages
to Hermes and OpenClaw. How it works: [DESIGN.md](DESIGN.md#online-version-added-13-november-2026).

1. **Vercel**: project `channel` (live at https://channel-eta-two.vercel.app), connected to GitHub, so every push deploys.
   The Vercel Supabase integration already set the Supabase settings. Add one by hand:
   - `OWNER_EMAIL`: the only email that may sign in (Settings → Environment Variables), then redeploy.
   `PUBLIC_URL` is optional; it defaults to the production address.
2. **Supabase** (project `Channel`, tables from `supabase/migrations/`): Authentication → URL Configuration → set
   **Site URL** to `https://channel-eta-two.vercel.app` and add it under Redirect URLs, so the sign-in email link works.
3. Open https://channel-eta-two.vercel.app and sign in with the emailed link.
4. **Mac bridge**: Agents → Mac bridge → Create bridge token. Put it in `~/.channel/bridge.json` (`chmod 600`) as shown
   there, with the Hermes and OpenClaw tokens, then run `npm run bridge` and keep it running.
5. **Muse or Hark**: Agents → Outside agent (MCP) → add it, copy its token, and tell the agent in its own chat to add
   the MCP server (the text to paste is shown). Its answers arrive at its next check-in.

## Tests

```bash
npm test
```

23 tests against scripted agents: routing, mentions, the privacy rule, hand-off approval and editing, auto mode and hop
limits, Stop, slow tasks, agent errors, wrong tokens, the guards that stop other web pages from using Channel, and the
online flow end to end (an outside agent on the MCP door through the official MCP client, plus the bridge).

## Where things are stored

`data/` (or the folder in `CHANNEL_DATA`): `channel.db` holds chats and messages, `agents.json` holds agent tokens
(readable only by you). Neither goes into git. The server only listens on `127.0.0.1`.
