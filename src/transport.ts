import { postToProject } from "./auth.ts";
import { actionPath, hexId, registrationId, stableId, type Action, type Delivery } from "./protocol.ts";
import type { Options } from "./options.ts";
export type Reference = Pick<Delivery, "registrationId" | "namespace" | "eventId">;
type WithoutContext<T> = T extends unknown ? Omit<T, keyof Reference | "version"> : never;
export type Output = WithoutContext<Action>;
export async function publish(options: Options, ref: Reference, output: Output) {
  const body = { version: 1, registrationId: ref.registrationId, namespace: ref.namespace, eventId: ref.eventId, ...output };
  const response = await postToProject(options.gatewayUrl, actionPath, body, await options.actionKey?.());
  if (response.status !== 202) throw new Error("Buzz gateway action unavailable (" + response.status + ")");
}
export function marker(ref: Pick<Reference, "namespace" | "eventId">) {
  return "[Buzz event " + stableId(ref.namespace, ref.eventId) + "]";
}
export function buzzAuth(message: Delivery) {
  return { authenticator: "buzz-gateway", issuer: "urn:buzz:" + message.namespace, principalId: message.author,
    principalType: "user", attributes: { buzzPublicKey: message.author, buzzNamespace: message.namespace,
      buzzRegistration: message.registrationId, buzzEvent: message.eventId, buzzDirect: String(message.direct), buzzVisibility: message.visibility ?? "unknown" } };
}
type Auth = { authenticator: string; issuer?: string; principalId: string; attributes: Readonly<Record<string, string | readonly string[]>> };
export function authenticatedReference(auth: Auth | null | undefined): Reference | undefined {
  if (auth?.authenticator !== "buzz-gateway") return;
  const { buzzNamespace: namespace, buzzRegistration: registration, buzzEvent: event } = auth.attributes;
  if (typeof namespace !== "string" || !hexId.safeParse(namespace).success || auth.issuer !== "urn:buzz:" + namespace
    || auth.attributes.buzzPublicKey !== auth.principalId || !hexId.safeParse(auth.principalId).success
    || typeof event !== "string" || !hexId.safeParse(event).success
    || typeof registration !== "string" || !registrationId.safeParse(registration).success) return;
  return { namespace, registrationId: registration, eventId: event };
}
