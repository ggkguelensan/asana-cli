import { z } from "zod";
import { gidSchema } from "./schemas";

const MAX_COMMENT_TEXT_LENGTH = 8_000;
const MAX_COMMENT_MENTIONS = 10;

export const commentTextSchema = z.string().min(1).max(MAX_COMMENT_TEXT_LENGTH);
export const mentionUserGidsSchema = z.array(gidSchema).min(1).max(MAX_COMMENT_MENTIONS)
  .refine((gids) => new Set(gids).size === gids.length, "Mention users must be unique")
  .meta({ uniqueItems: true });

const mentionedUserSchema = z.strictObject({
  gid: gidSchema,
  name: z.string().max(500).optional(),
});

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

export function renderMentionComment(text: string, gids: readonly string[]): string {
  const mentions = gids.map((gid) => `<a data-asana-gid="${gid}"/>`).join(" ");
  const paragraphs = text.split(/\r\n|\r|\n/)
    .map((line) => `<p>${escapeXml(line)}</p>`).join("");
  return `<body><p>${mentions}</p>${paragraphs}</body>`;
}

export const commentPayloadSchema = z.union([
  z.strictObject({ text: commentTextSchema }),
  z.strictObject({
    text: commentTextSchema,
    mentions: z.array(mentionedUserSchema).min(1).max(MAX_COMMENT_MENTIONS),
    html_text: z.string().min(1).max(65_536),
  }).refine((payload) => {
    const gids = payload.mentions.map((user) => user.gid);
    return new Set(gids).size === gids.length &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(payload.text) &&
      payload.html_text === renderMentionComment(payload.text, gids);
  }, "Mention comment must contain canonical, valid XML"),
]);

export type MentionedUser = z.output<typeof mentionedUserSchema>;
export type CommentPayload = z.output<typeof commentPayloadSchema>;

export function commentWireContent(payload: CommentPayload): { text: string } | { html_text: string } {
  return "html_text" in payload ? { html_text: payload.html_text } : { text: payload.text };
}
