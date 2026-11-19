import { createHash } from "node:crypto";
import { z } from "zod";

export const hexId = z.string().regex(/^[a-f0-9]{64}$/);
export const registrationId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const projectIdentity = z.object({
  teamSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  environment: z.string().regex(/^[A-Za-z0-9_-]+$/).default("production"),
  issuerMode: z.enum(["team", "global"]).default("team"),
});
export type ProjectIdentity = z.infer<typeof projectIdentity>;

export const deliverySchema = z.object({
  version: z.literal(1),
  registrationId,
  namespace: hexId,
  eventId: hexId,
  conversationId: hexId,
  community: z.url().optional(),
  roomId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  author: hexId,
  direct: z.boolean(),
  mentioned: z.boolean().optional(),
  visibility: z.enum(["private", "public"]).optional(),
  text: z.string().min(1).max(16000),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const deliveryReferenceSchema = deliverySchema.omit({ text: true });

const actionContext = { version: z.literal(1), registrationId, namespace: hexId, eventId: hexId };
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ ...actionContext, kind: z.literal("reply"), text: z.string().trim().min(1).max(16000) }),
  z.object({ ...actionContext, kind: z.literal("reaction"), emoji: z.string().trim().min(1).max(24) }),
  z.object({ ...actionContext, kind: z.literal("typing") }),
  z.object({ ...actionContext, kind: z.literal("status"), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    text: z.string().trim().min(1).max(1800).nullable(), busy: z.boolean() }),
]);
export type Action = z.infer<typeof actionSchema>;
export const receiptSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  deliveryId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
});
export type EveReceipt = z.infer<typeof receiptSchema>;

export const eveDeliveryPath = "/integrations/buzz/events";
export const eveResultPath = "/integrations/buzz/result";
export const deliveryStatusHeader = "x-buzz-delivery-status";
export const actionPath = "/api/actions";
export const actionKeyHeader = "x-buzz-gateway-key";

export function stableId(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function readJson(request: Request, maxBytes = 48_000): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) {
    throw new Error("Expected a JSON request");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("JSON request exceeds size limit");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
