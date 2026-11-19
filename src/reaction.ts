import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { optionsSchema, type BuzzChannelOptions } from "./options.ts";
import { authenticatedReference, publish } from "./transport.ts";
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
export const emojiSchema = z.string().max(24).refine(value =>
  [...segmenter.segment(value)].length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value), "Use one Unicode emoji");
export function createBuzzReactionTool(input: BuzzChannelOptions) {
  const options = optionsSchema.parse(input);
  const tool = defineTool({
    description: "React to the current Buzz message with one emoji. Set finish to true when the reaction is your entire answer.",
    inputSchema: z.object({ emoji: emojiSchema, finish: z.boolean().default(false) }).strict(),
    outputSchema: z.object({ finished: z.boolean() }),
    label: false,
    endsTurn: output => output.finished,
    async execute({ emoji, finish }, ctx) {
      const ref = authenticatedReference(ctx.session.auth.current);
      if (!ref) throw new Error("This reaction needs an authenticated Buzz message.");
      await publish(options, ref, { kind: "reaction", emoji });
      return { finished: finish };
    },
  });
  return defineDynamic(ctx => authenticatedReference(ctx.session.auth.current) ? tool : null);
}
