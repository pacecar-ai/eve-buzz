import { z } from "zod";
import { projectIdentity, type Delivery } from "./protocol.ts";
export type BuzzDeliveryAccess = Pick<Delivery, "community" | "roomId" | "author" | "direct">;
export const optionsSchema = z.object({
  gatewayUrl: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value.replace(/\/$/, "");
  }, "Expected an HTTPS gateway origin"),
  gatewayProject: projectIdentity,
  authorizeDelivery: z.custom<(delivery: BuzzDeliveryAccess) => boolean>(v => typeof v === "function").optional(),
  actionKey: z.custom<() => Promise<string>>(v => typeof v === "function").optional(),
  threadMode: z.enum(["mentions", "joined"]).default("mentions"),
  toolLabels: z.record(z.string(), z.string().trim().min(1).max(100)).default({}),
  dashboard: z.object({ team: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    environment: z.enum(["production", "preview"]).default("production") }).optional(),
});
export type BuzzChannelOptions = z.input<typeof optionsSchema>;
export type Options = z.output<typeof optionsSchema>;
export function dashboardUrl(dashboard: Options["dashboard"], sessionId: string): string | undefined {
  if (dashboard && /^wrun_[0-9A-Za-z]{1,80}$/.test(sessionId)) {
    return "https://vercel.com/" + dashboard.team + "/" + dashboard.project + "/observability/agent-runs/"
      + sessionId + "?environment=" + dashboard.environment + "&period=30d";
  }
}
