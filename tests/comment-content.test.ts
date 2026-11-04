import { describe, expect, test } from "bun:test";
import {
  commentPayloadSchema,
  commentWireContent,
  mentionUserGidsSchema,
  renderMentionComment,
} from "../src/comment-content";

describe("mention comment content", () => {
  test("escapes arbitrary text and preserves lines and Unicode without interpreting HTML", () => {
    const text = 'QA <script> & "quotes" \'apostrophe\'\r\n🙂 https://example.test/?a=1&b=2';
    expect(renderMentionComment(text, ["2001"])).toBe('<body><p><a data-asana-gid="2001"/></p><p>QA &lt;script&gt; &amp; &quot;quotes&quot; &apos;apostrophe&apos;</p><p>🙂 https://example.test/?a=1&amp;b=2</p></body>');
  });
  test("keeps old plain-text operations and sends exactly one Asana content field", () => {
    expect(commentWireContent(commentPayloadSchema.parse({ text: "Old comment" }))).toEqual({ text: "Old comment" });
    const html = renderMentionComment("Review", ["2001"]);
    expect(commentWireContent(commentPayloadSchema.parse({ text: "Review", mentions: [{ gid: "2001", name: "Reviewer" }], html_text: html }))).toEqual({ html_text: html });
  });
  test("bounds unique exact user IDs", () => {
    for (const gids of [[], ["2001", "2001"], ["not-a-gid"], Array.from({ length: 11 }, (_, i) => String(2000 + i))]) {
      expect(mentionUserGidsSchema.safeParse(gids).success).toBe(false);
    }
    expect(mentionUserGidsSchema.parse(["2001", "2002"])).toEqual(["2001", "2002"]);
  });
  test("rejects mismatched HTML and invalid XML characters in durable records", () => {
    for (const text of ['\0', '\ud800', '\uffff']) {
      expect(commentPayloadSchema.safeParse({ text, mentions: [{ gid: "2001" }], html_text: renderMentionComment(text, ["2001"]) }).success).toBe(false);
    }
    expect(commentPayloadSchema.safeParse({ text: "Review", mentions: [{ gid: "2001" }], html_text: renderMentionComment("Other text", ["2001"]) }).success).toBe(false);
    expect(commentPayloadSchema.safeParse({ text: "Review", mentions: [{ gid: "2001" }], html_text: renderMentionComment("Review", ["2002"]) }).success).toBe(false);
  });
});
