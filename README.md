# Eve Buzz channel

Run a Vercel Eve agent in a Buzz community. People can mention the agent, talk to it in a direct message, see it working, stop a turn, and receive a threaded reply or a reaction from the agent's own Buzz profile.

The channel follows the interaction model of Eve's Slack channel. The signed-event transport was inspired by Eve's Discord gateway relay. [Eve Slack channel](https://eve.dev/docs/channels/slack/reference) · [Discord relay by Ben Pankow](https://github.com/vercel/eve/pull/4934)

## Install

Use Node 24 or newer and Eve 1.1. Install the published GitHub release in your agent project.

```sh
npm install eve@^1.1.0 https://github.com/pacecar-ai/eve-buzz/releases/download/v1.1.0/pacecar-ai-eve-buzz-1.1.0.tgz
```

Deploy a Buzz gateway, register the Eve project's workload and link one Buzz credential to the agent. The desktop plugin lets a community owner authorize its identity, add it to rooms and enable Buzz teams. [Gateway setup](https://github.com/pacecar-ai/buzz-gateway) · [Buzz Desktop plugin](https://github.com/pacecar-ai/buzz-vercel-plugin)

Keep the shared options in an ordinary module outside your Eve channel and tool discovery directories. Configure the gateway's HTTPS origin and project identity in your deployment environment. If your registered credential requires an action key, resolve it from your agent's connector on each callback.

```ts
// buzz.ts
import type { BuzzChannelOptions } from "@pacecar-ai/eve-buzz";

export const buzz: BuzzChannelOptions = {
  gatewayUrl: process.env.BUZZ_GATEWAY_ORIGIN!,
  gatewayProject: JSON.parse(process.env.BUZZ_GATEWAY_PROJECT!),
  actionKey: async () => {
    const { getToken } = await import("@vercel/connect");
    const token = await getToken(process.env.BUZZ_GATEWAY_CONNECTOR!, { subject: { type: "app" } });
    return token.startsWith("{") ? JSON.parse(token).actionKey : token;
  },
};
```

This credential example uses the optional `@vercel/connect` package. Install it in the agent project when using Connect. The gateway identity has a `teamSlug`, `teamId` and `projectId`. Its environment defaults to production and its issuer defaults to the team issuer.

```ts
// agent/channels/buzz.ts
import { createBuzzChannel } from "@pacecar-ai/eve-buzz";
import { buzz } from "../../buzz.js";
export default createBuzzChannel(buzz);
```

```ts
// agent/tools/buzz_react.ts
import { createBuzzReactionTool } from "@pacecar-ai/eve-buzz";
import { buzz } from "../../buzz.js";
export default createBuzzReactionTool(buzz);
```

## Conversation behavior

| Interaction | Behavior |
| --- | --- |
| Channel messages | Each ordinary message needs a signed mention, including follow-ups. Set `threadMode: "joined"` to opt into untagged replies after the agent joins a thread. |
| Direct messages | Messages from verified members continue the same conversation. |
| Working feedback | Buzz shows typing and an editable activity message. Eve supplies thinking, visible tool execution, background tasks, waiting for input and writing states. The gateway clears transient activity on settlement. Provide static `toolLabels` to display names appropriate for the room. |
| Replies | The agent publishes its completed answer in the originating thread. A lost callback can be recovered from the original Eve delivery. |
| Reactions | Install the optional reaction tool for Unicode, built-in picker names like `:eyes:`, and custom community emoji. The gateway resolves custom image names from the signed Buzz community catalogue. Eve can finish a turn with just the reaction. |
| Questions and approvals | In a DM or verified private room, the person who started the turn can reply with the option number, label, or requested text. In a channel, include a mention. Shared public rooms show a waiting notice. Sign-in challenges remain in the authenticated session. |
| Stop | Copy the short `/stop` command from the activity message. In a room, mention the agent with the command. The turn ID and the initiating Buzz identity are checked before cancellation. |
| Vercel link | Set `dashboard: { team, project }` to attach a protected Agent Runs link to the answer and waiting notices. |

## Gateway contract

The gateway verifies signed Buzz events and room membership. It POSTs a version-1 delivery to `/integrations/buzz/events` with the registration, namespace, event and conversation IDs, author, community, room ID, direct flag, signed mention flag, visibility and text. The channel authenticates the source using Vercel OIDC and returns an Eve session and delivery receipt. The gateway can POST that receipt and delivery reference to `/integrations/buzz/result` to recover the original answer.

The agent POSTs receipt-scoped `typing`, `status`, `reply` and `reaction` actions to `/api/actions`. The gateway chooses the destination from the admitted event, validates the calling project and per-agent credential, and handles retries. Signed Buzz identities reach Eve as `buzz-gateway` principals. Provider permissions can be configured separately for those principals. [Wire schemas](./src/protocol.ts)

## Development

Run `npm ci`, `npm test` and `npm run build`. A version tag matching `package.json` runs the GitHub Actions checks and publishes the installable archive to GitHub Releases.
