import { describe, expect, it } from "vitest";
import { quoteForSide, splitQuote, takeSideQuote, withQuote } from "@/lib/side-quote";

describe("asking a side question about a passage", () => {
  it("sends the passage as a Markdown quote ahead of the question, and reads it back", () => {
    const asked = withQuote("现在补跑现有的小程序启动回归\n完成提交前验证。", "为什么要补跑？");
    expect(asked).toBe("> 现在补跑现有的小程序启动回归\n> 完成提交前验证。\n\n为什么要补跑？");
    expect(splitQuote(asked)).toEqual({ quote: "现在补跑现有的小程序启动回归\n完成提交前验证。", question: "为什么要补跑？" });
  });

  it("leaves a question without a passage as it is", () => {
    expect(withQuote(undefined, "改了哪些文件？")).toBe("改了哪些文件？");
    expect(splitQuote("改了哪些文件？")).toEqual({ question: "改了哪些文件？" });
  });

  it("hands a picked passage to the side conversation once, trimmed and cut to a passage's length", () => {
    quoteForSide("s1", "  release/1.1.72  ");
    expect(takeSideQuote("s1")).toBe("release/1.1.72");
    expect(takeSideQuote("s1")).toBeUndefined();

    quoteForSide("s2", "字".repeat(5000));
    expect(takeSideQuote("s2")).toBe(`${"字".repeat(2000)}…`);

    quoteForSide("s3", "   ");
    expect(takeSideQuote("s3")).toBeUndefined();
  });
});
