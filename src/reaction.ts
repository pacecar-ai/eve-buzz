import palette from "@emoji-mart/data/sets/15/native.json" with { type: "json" };
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { optionsSchema, type BuzzChannelOptions } from "./options.ts";
import { authenticatedReference, publish } from "./transport.ts";
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const aliases: Record<string, string> = palette.aliases;
const emoji: Record<string, { skins: { native: string }[] }> = palette.emojis;
export function resolveEmoji(input: string): string | undefined {
  const name = /^:([a-z0-9_+-]{1,64}):$/i.exec(input)?.[1].toLowerCase();
  if (name) {
    const key = Object.hasOwn(aliases, name) ? aliases[name] : name;
    if (Object.hasOwn(emoji, key)) return emoji[key].skins[0]?.native;
    if (/^[a-z0-9_-]+$/.test(name)) return ":" + name + ":";
    return;
  }
  if (input.length <= 24 && [...segmenter.segment(input)].length === 1
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(input)) return input;
}
export const emojiSchema = z.string().max(66).refine(value => Boolean(resolveEmoji(value)), "Use one emoji or a :shortcode:");
export function createBuzzReactionTool(input: BuzzChannelOptions) {
  const options = optionsSchema.parse(input);
  const tool = defineTool({
    description: "React to the current Buzz message with a Unicode emoji or a :shortcode: from the Buzz emoji picker. Set finish to true when the reaction is your entire answer.",
    inputSchema: z.object({ emoji: emojiSchema, finish: z.boolean().default(false) }).strict(),
    outputSchema: z.object({ finished: z.boolean() }),
    label: false,
    endsTurn: output => output.finished,
    async execute({ emoji, finish }, ctx) {
      const ref = authenticatedReference(ctx.session.auth.current);
      if (!ref) throw new Error("This reaction needs an authenticated Buzz message.");
      await publish(options, ref, { kind: "reaction", emoji: resolveEmoji(emoji)! });
      return { finished: finish };
    },
  });
  return defineDynamic(ctx => authenticatedReference(ctx.session.auth.current) ? tool : null);
}
