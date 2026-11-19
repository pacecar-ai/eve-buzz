import assert from "node:assert/strict";
import { test } from "node:test";
import { addressed, buildChannel, createBuzzChannel } from "../src/channel.ts";
import { emojiSchema } from "../src/reaction.ts";
import { completedReply, ownsTurn, publicStatus, snapshot } from "../src/render.ts";
import { dashboardUrl, optionsSchema } from "../src/options.ts";
import { authenticatedReference, buzzAuth, marker } from "../src/transport.ts";
import { stableId, type Delivery } from "../src/protocol.ts";

const config = { gatewayUrl: "https://gateway.example", gatewayProject: { teamSlug: "example", teamId: "team_example", projectId: "prj_example" },
  dashboard: { team: "example", project: "agent" } };
const message: Delivery = { version: 1, eventId: "a".repeat(64), namespace: "b".repeat(64), conversationId: "c".repeat(64),
  registrationId: "example", author: "d".repeat(64), community: "wss://relay.example", roomId: "group", direct: false, mentioned: true, text: "Hello" };
const receipt = { sessionId: "wrun_fixture", deliveryId: "input" };
const request = (value: unknown) => new Request("https://agent.example", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
function reader(facts: any[]) {
  return { id: receipt.sessionId, async *stream() {
    for (const [line, fact] of facts.entries()) yield { ...fact, meta: { at: "2026-01-01T00:00:00Z", position: { line, index: 0 }, endOfLine: true } };
  } };
}
function turnFacts(d: Delivery = message) {
  return [
    { type: "delivery.admitted", data: { deliveryId: "input", principal: { id: d.author, type: "user", issuer: "urn:buzz:" + d.namespace }, source: { channel: "buzz" } } },
    { type: "turn.started", data: { turnId: "turn" } },
    { type: "delivery.consumed", data: { deliveryId: "input", turnId: "turn", parts: [{ kind: "text", text: marker(d) + "\n" + d.text }] } },
  ];
}
function harness(facts?: any[]) {
  const actions: any[] = [], sent: any[] = [], answered: any[] = [], cancelled: any[] = [];
  const channel = buildChannel(config, async () => true, async (_opts, ref, action) => { actions.push({ ref, action }); });
  const source = {
    async send(text: string, opts: any) { sent.push({ text, opts }); return receipt; },
    async respond(answers: any[], opts: any) { answered.push({ answers, opts }); return receipt; },
    async cancel(opts: any) { cancelled.push(opts); return receipt; },
  };
  const ctx: any = { from: (address: string) => { assert.equal(address, message.conversationId); return source; },
    waitUntil() {}, resolveSession: async () => facts && reader(facts), attachSession: () => reader(facts ?? []) };
  return { actions, sent, answered, cancelled, receive: (d: Delivery) => channel.routes[0].handler(request(d), ctx),
    result: () => channel.routes[1].handler(request({ ...message, receipt }), ctx) };
}
test("workload verification precedes request parsing and session creation", async () => {
  for (const route of createBuzzChannel(config).routes) assert.equal((await route.handler(request(message), {} as never)).status, 403);
});
test("each channel input needs a signed mention; direct and joined modes can accept ordinary chat", async () => {
  const h = harness();
  const unaddressed = { ...message, mentioned: false, text: "@example hello" };
  assert.equal((await h.receive(unaddressed)).headers.get("x-buzz-delivery-status"), "denied");
  assert.equal((await h.receive({ ...unaddressed, mentioned: undefined })).status, 403);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.receive(message)).status, 202);
  assert.equal(h.sent[0].opts.auth.principalId, message.author);
  assert.equal(h.sent[0].opts.idempotencyKey, "buzz:" + stableId(message.namespace, message.eventId));
  assert.equal((await h.receive({ ...unaddressed, direct: true })).status, 202);
  assert.equal(addressed(unaddressed, "joined"), true);
});
test("reconciliation scopes output to the original recorded turn and produces the same receipt-scoped action on replay", async () => {
  const facts = [...turnFacts(), { type: "content.completed", scope: { turnId: "turn" },
    data: { kind: "text", phase: "reply", partId: "reply", value: "Here is the answer." } },
    { type: "turn.settled", data: { turnId: "turn", outcome: "completed", reply: ["reply"] } },
    { type: "delivery.settled", data: { turnId: "turn", deliveryId: "input", outcome: "handled" } }];
  const h = harness(facts);
  assert.equal((await h.result()).status, 200);
  assert.equal((await h.result()).status, 200);
  assert.deepEqual(h.actions.slice(0, 2), h.actions.slice(2));
  assert.match(h.actions[0].action.text, /^Here is the answer\.\n\n\[View conversation in Vercel\]/);
  assert.equal(h.actions[1].action.text, null);
  const view = await snapshot(reader(facts));
  assert.equal(ownsTurn(view, "turn", message.author, message.namespace), true);
  assert.equal(ownsTurn(view, "turn", "e".repeat(64), message.namespace), false);
  assert.equal(completedReply(view, "turn"), "Here is the answer.");
  assert.equal(dashboardUrl(optionsSchema.parse(config).dashboard, "../foo"), undefined);
});
test("an emoji-only response is valid and cannot target another room or Slack principal", () => {
  for (const value of ["👩🏽‍💻", "👍", "❤️", "🇨🇦", "1️⃣"]) assert.equal(emojiSchema.safeParse(value).success, true);
  for (const value of ["hello", "👍👍", "", ":thumbsup:"]) assert.equal(emojiSchema.safeParse(value).success, false);
  assert.equal(authenticatedReference({ ...buzzAuth(message), authenticator: "slack" }), undefined);
  assert.equal(authenticatedReference({ ...buzzAuth(message), issuer: "urn:buzz:elsewhere" }), undefined);
  assert.equal(authenticatedReference(buzzAuth(message))?.eventId, message.eventId);
});
test("typed controls apply only to the originating user and named turn", async () => {
  const h = harness(turnFacts());
  const stop = "/stop " + stableId(message.namespace, "turn").slice(0, 8);
  assert.equal((await h.receive({ ...message, text: stop, author: "e".repeat(64) })).status, 403);
  assert.equal((await h.receive({ ...message, text: "/stop deadbeef" })).status, 403);
  assert.equal((await h.receive({ ...message, text: stop })).status, 202);
  assert.equal(h.cancelled.length, 1);
  assert.equal(h.cancelled[0].turnId, "turn");
});
test("human questions expose choices in DMs and never reveal sign-in data to rooms", async () => {
  const q = { type: "interaction.opened", data: { interactionId: "q", subject: { turnId: "turn" },
    request: { kind: "question", prompt: "Which account?", options: [{ id: "yes", label: "The first one" }] }, origin: "tool" },
    scope: { turnId: "turn" } };
  const facts = [...turnFacts(), q];
  const view = await snapshot(reader(facts));
  const opts = optionsSchema.parse(config);
  assert.match(publicStatus(view, "turn", opts, true).text, /Which account/);
  assert.doesNotMatch(publicStatus(view, "turn", opts, false).text, /Which account/);
  const h = harness(facts);
  assert.equal((await h.receive({ ...message, direct: true, text: "1" })).status, 202);
  assert.equal(h.answered[0].answers[0].optionId, "yes");
  assert.equal((await h.receive({ ...message, direct: true, author: "e".repeat(64), text: "1" })).status, 403);
});
