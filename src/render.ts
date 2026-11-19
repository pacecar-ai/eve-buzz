import { activity, calls, deliveries, delivery, emptySessionView, foldEvents, nextPrompt, reply, showsActivity, turn,
  type SessionView } from "eve/events";
import type { SessionReader } from "eve/sessions";
import type { Options } from "./options.ts";
import { marker, type Reference } from "./transport.ts";

export async function snapshot(session: SessionReader, signal?: AbortSignal): Promise<SessionView> {
  const events = [];
  for await (const event of session.stream({ follow: false, signal })) events.push(event);
  return foldEvents(emptySessionView(), events);
}
export function ownsTurn(view: SessionView, turnId: string, author: string, namespace: string) {
  const first = deliveries(view, { turnId }).find(input => input.parts?.some(part => part.kind === "text"));
  return first?.principal?.type === "user" && first.principal.id === author && first.principal.issuer === "urn:buzz:" + namespace;
}
export function isOriginal(view: SessionView, deliveryId: string, ref: Reference) {
  const first = delivery(view, deliveryId)?.parts?.[0];
  return first?.kind === "text" && first.text.startsWith(marker(ref) + "\n");
}
export function publicStatus(view: SessionView, turnId: string, options: Options, direct: boolean, link?: string) {
  const prompt = nextPrompt(view);
  if (prompt?.turnId === turnId) {
    const request = prompt.request;
    if (direct && (request.kind === "approval" || request.kind === "question")) {
      const choices = request.options?.map((choice, index) => (index + 1) + ". " + choice.label).join("\n");
      return { text: [request.prompt, choices, choices ? "Reply with your choice." : "Reply in this conversation."].filter(Boolean).join("\n").slice(0, 1800), busy: false };
    }
    const label = request.kind === "approval" ? "Waiting for your approval" : request.kind === "sign-in" ? "Waiting for sign-in" : "Waiting for your input";
    return { text: label + (link ? " · [Open in Vercel](" + link + ")" : ". Open the agent session to review."), busy: false };
  }
  const current = activity(view, { turnId });
  if (current.kind === "calling") {
    const names = calls(view, { turnId }).filter(c => showsActivity(c) && ["requested", "running"].includes(c.state))
      .map(c => Object.hasOwn(options.toolLabels, c.name) ? options.toolLabels[c.name] : undefined);
    return { text: names.filter(Boolean).join(" · ").slice(0, 1800) || "Using a tool…", busy: true };
  }
  if (current.kind === "waiting-on-tasks") return { text: current.tasks.length === 1 ? "Waiting for a task…" : "Waiting for " + current.tasks.length + " tasks…", busy: true };
  if (current.kind === "compacting") return { text: "Organizing the conversation…", busy: true };
  return { text: "Thinking…", busy: true };
}
export function completedReply(view: SessionView, turnId: string, link?: string): string | undefined {
  const outcome = turn(view, turnId)?.outcome;
  if (outcome === "failed") return "I couldn’t finish this request. Mention me again to try a new turn.";
  if (outcome === "cancelled") return "Stopped.";
  const text = reply(view, turnId).filter(part => part.kind === "text" && !part.interrupted && typeof part.value === "string")
    .map(part => part.value).join("\n\n").trim();
  if (!text) return;
  const footer = link ? "\n\n[View conversation in Vercel](" + link + ")" : "";
  const max = 16000 - footer.length;
  return (text.length > max ? text.slice(0, max - 1) + "…" : text) + footer;
}
