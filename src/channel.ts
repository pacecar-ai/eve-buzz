import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import { activeTurn, contentPreviews, deliveries, delivery, nextPrompt, position, turn, type SessionView } from "eve/events";
import { fromProject } from "./auth.ts";
import { errorName, log } from "./log.ts";
import { dashboardUrl, optionsSchema, type BuzzChannelOptions, type Options } from "./options.ts";
import { deliveryReferenceSchema, deliverySchema, deliveryStatusHeader, eveDeliveryPath, eveResultPath,
  readJson, receiptSchema, stableId, type Delivery } from "./protocol.ts";
import { completedReply, isOriginal, ownsTurn, publicStatus, snapshot } from "./render.ts";
import { authenticatedReference, buzzAuth, marker, publish, type Output, type Reference } from "./transport.ts";
export { eveDeliveryPath, eveResultPath };

type Binding = { ref: Reference; author: string; direct: boolean; visibility?: Delivery["visibility"] };
type State = { incoming?: Binding; active?: Binding & { turnId: string }; lastText?: string };
const resultRequest = deliveryReferenceSchema.extend({ receipt: receiptSchema });
const denied = () => new Response(null, { status: 403, headers: { [deliveryStatusHeader]: "denied" } });
const timeout = (request: Request) => AbortSignal.any([request.signal, AbortSignal.timeout(7500)]);
const stopCode = (namespace: string, turnId: string) => stableId(namespace, turnId).slice(0, 8);
export const addressed = (input: Pick<Delivery, "direct" | "mentioned">, mode: Options["threadMode"]) =>
  input.direct || input.mentioned === true || mode === "joined";
function choiceText(text: string) {
  return text.replace(/^\s*\[@?[^\]\n]+\]\((?:buzz:agent-profile:|nostr:)[^)]+\)\s*/i, "").trim();
}
function statusFor(view: SessionView, binding: Binding, turnId: string, options: Options, sessionId: string) {
  const status = publicStatus(view, turnId, options, binding.direct || binding.visibility === "private", dashboardUrl(options.dashboard, sessionId));
  if (status.busy) status.text += "\nStop this turn with \u0060/stop " + stopCode(binding.ref.namespace, turnId) + "\u0060.";
  return status;
}
function report(ref: Reference, error: unknown) {
  log("warn", "buzz_callback_pending", { registrationId: ref.registrationId, eventId: ref.eventId, error: errorName(error) });
}

export function createBuzzChannel(input: BuzzChannelOptions) {
  return buildChannel(input, fromProject, publish);
}
export function buildChannel(input: BuzzChannelOptions, verify: typeof fromProject, publishAction: typeof publish) {
  const options = optionsSchema.parse(input);
  const emit = (ref: Reference, output: Output) => publishAction(options, ref, output);
  async function finish(ref: Reference, view: SessionView, turnId: string, sessionId: string, revision: number) {
    const text = completedReply(view, turnId, dashboardUrl(options.dashboard, sessionId));
    if (text) await emit(ref, { kind: "reply", text });
    await emit(ref, { kind: "status", revision, busy: false, text: null });
  }
  async function receive(message: Delivery, ctx: RouteHandlerArgs<State>, request: Request) {
    if (!addressed(message, options.threadMode) || options.authorizeDelivery?.(message) === false) return denied();
    const ref = { registrationId: message.registrationId, namespace: message.namespace, eventId: message.eventId };
    const auth = buzzAuth(message);
    const idempotencyKey = "buzz:" + stableId(message.namespace, message.eventId);
    const binding = { ref, author: message.author, direct: message.direct, visibility: message.visibility };
    const source = ctx.from(message.conversationId);
    const existing = await ctx.resolveSession(message.conversationId);
    const view = existing ? await snapshot(existing, timeout(request)) : undefined;
    const text = choiceText(message.text);
    const stop = /^\/stop(?:\s+([0-9a-f]{8}))?$/i.exec(text);
    const prompt = view && nextPrompt(view);
    let receipt;
    if (stop) {
      const running = view && activeTurn(view);
      if (!running || !view || stop[1]?.toLowerCase() !== stopCode(message.namespace, running.turnId)
        || !ownsTurn(view, running.turnId, message.author, message.namespace)) return denied();
      receipt = await source.cancel({ turnId: running.turnId, auth });
    } else if (prompt && view) {
      if (!ownsTurn(view, prompt.turnId, message.author, message.namespace) || !(message.direct || message.visibility === "private")
        || !["question", "approval"].includes(prompt.request.kind)) return denied();
      const choices = prompt.request.options ?? [];
      const choice = choices.find((c, i) => String(i + 1) === text || c.id === text || c.label.toLowerCase() === text.toLowerCase());
      if (choice) receipt = await source.respond([{ interactionId: prompt.interactionId, optionId: choice.id }], { auth, idempotencyKey });
      else if (prompt.request.allowFreeform) receipt = await source.respond([{ interactionId: prompt.interactionId, text }], { auth, idempotencyKey });
      else return denied();
    } else {
      receipt = await source.send(marker(message) + "\n" + message.text, {
        auth, idempotencyKey, state: { incoming: binding }, turnPolicy: "queue",
      });
      ctx.waitUntil(emit(ref, { kind: "typing" }).catch(error => report(ref, error)));
    }
    return Response.json({ sessionId: receipt.sessionId, deliveryId: receipt.deliveryId }, { status: 202 });
  }
  return defineChannel<State, { state: State }>({
    state: {}, context: state => ({ state }), turnPolicy: "queue", uploadPolicy: "disabled",
    audience: ({ state }) => state.incoming?.direct ? "private" : state.incoming?.visibility ?? "unknown",
    routes: [
      POST(eveDeliveryPath, async (request, ctx) => {
        if (!await verify(request, options.gatewayProject)) return new Response(null, { status: 403 });
        const parsed = deliverySchema.safeParse(await readJson(request).catch(() => null));
        return parsed.success ? receive(parsed.data, ctx, request) : new Response(null, { status: 400 });
      }),
      POST(eveResultPath, async (request, { attachSession }) => {
        if (!await verify(request, options.gatewayProject)) return new Response(null, { status: 403 });
        const parsed = resultRequest.safeParse(await readJson(request).catch(() => null));
        if (!parsed.success) return new Response(null, { status: 400 });
        const message = parsed.data;
        if (options.authorizeDelivery?.(message) === false) return denied();
        const { receipt } = message;
        const view = await snapshot(attachSession(receipt.sessionId), timeout(request));
        // Retried sends on earlier gateway versions can receive a different receipt for the same input.
        const row = deliveries(view).find(item => isOriginal(view, item.deliveryId, message));
        if (!row?.turnId) {
          return new Response(null, { status: delivery(view, receipt.deliveryId)?.status === "settled" ? 200 : 202 });
        }
        const state = turn(view, row.turnId);
        if (state?.status === "settled") {
          await finish(message, view, row.turnId, receipt.sessionId, position(view) * 2 + 1);
          return new Response(null, { status: 200 });
        }
        const visible = statusFor(view, { ref: message, direct: message.direct, author: message.author, visibility: message.visibility }, row.turnId, options, receipt.sessionId);
        await emit(message, { kind: "status", revision: position(view) * 2, ...visible });
        if (visible.busy) await emit(message, { kind: "typing" });
        return new Response(null, { status: 202 });
      }),
    ],
    events: {
      committed(line, ctx) {
        const state = ctx.channel.state;
        for (const fact of line.facts) {
          if (fact.type !== "delivery.consumed") continue;
          const auth = ctx.session.auth.current;
          const ref = authenticatedReference(auth);
          const candidates = [state.incoming, ref && auth ? { ref, author: auth.principalId, direct: auth.attributes.buzzDirect === "true", visibility: auth.attributes.buzzVisibility === "private" ? "private" as const : undefined } : undefined];
          const input = candidates.find(b => b && isOriginal(ctx.view, fact.data.deliveryId, b.ref));
          if (input) {
            state.active = { ...input, turnId: fact.data.turnId };
            delete state.lastText;
          }
        }
        const active = state.active;
        if (!active) return;
        const { turnId, ref } = active;
        const revision = line.position * 2;
        if (turn(ctx.view, turnId)?.status === "settled") {
          ctx.waitUntil(finish(ref, ctx.view, turnId, ctx.session.id, revision + 1).catch(error => report(ref, error)));
          delete state.active;
          delete state.lastText;
          return;
        }
        const status = statusFor(ctx.view, active, turnId, options, ctx.session.id);
        if (status.text === state.lastText) return;
        state.lastText = status.text;
        ctx.waitUntil(emit(ref, { kind: "status", revision, ...status }).catch(error => report(ref, error)));
      },
      "content.delta"(event, ctx) {
        const active = ctx.channel.state.active;
        if (!active || !(event.data.kind === "text" || contentPreviews(ctx.view).some(p => p.partId === event.data.partId && p.kind === "text")) || (event.scope?.turnId && event.scope.turnId !== active.turnId)) return;
        // Eve's Slack renderer lets a long response show a writing status before publishing the completed text.
        const started = turn(ctx.view, active.turnId)?.startedAt;
        if (!started || Date.now() - Date.parse(started) < 3500) return;
        const text = "Writing a reply…";
        if (ctx.channel.state.lastText === text) return;
        ctx.channel.state.lastText = text;
        ctx.waitUntil(emit(active.ref, { kind: "status", revision: ctx.position.line * 2, busy: true, text })
          .catch(error => report(active.ref, error)));
      },
    },
  });
}
