// Starts two test agents for trying the app by hand: Ada (port 9101, OpenClaw-style replies) and
// Bo (port 9102, plain-message replies). Add them in the app with the tokens printed below.
import { startMockAgent } from "./mock-agent.ts";

const ada = await startMockAgent({ name: "Ada", port: 9101, token: "test-ada", style: "task", partner: "Bo", path: "/a2a/v1" });
const bo = await startMockAgent({ name: "Bo", port: 9102, token: "test-bo", style: "message", partner: "Ada" });
console.log(`Test agents running (local test tokens, not secrets):
  Ada  ${ada.url}   token test-ada
  Bo   ${bo.url}   token test-bo
Try: "ask Bo what's up", "loop", "slow", "fail".`);
