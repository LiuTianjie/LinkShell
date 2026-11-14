import { describe, expect, it } from "vitest";
import { RpcError } from "@linkshell/wire";
import { actionErrorText, errorCode } from "@/lib/action-error";

describe("actionErrorText", () => {
  it("never shows the RPC method or its limit for a timeout or a dropped connection", () => {
    const timeout = RpcError.app("timeout", "请求超时（sessions.archive，30000 ms）");
    const closed = RpcError.app("closed", "连接已断开 (fs.read)");
    expect(actionErrorText(timeout, "zh")).toBe("电脑没有及时响应，请稍后再试");
    expect(actionErrorText(closed, "zh")).toBe("连接断开了，连上后再试");
    expect(actionErrorText(timeout, "en")).not.toMatch(/sessions|ms|[一-鿿]/);
    // A peer that rejected with the bare message, no code attached.
    expect(actionErrorText(new Error("请求超时（fs.read，20000 ms）"), "zh")).toBe("电脑没有及时响应，请稍后再试");
    expect(actionErrorText(new Error("正在重新连接 (terminals.create)"), "zh")).toBe("连接断开了，连上后再试");
  });

  it("keeps what the computer itself said", () => {
    const host = RpcError.app("not_found", "找不到文件夹：/tmp/gone");
    expect(actionErrorText(host, "zh")).toBe("找不到文件夹：/tmp/gone");
    expect(errorCode(host)).toBe("not_found");
    expect(actionErrorText(RpcError.app("offline", "没有连上电脑"), "ja")).toContain("PC");
  });

  it("has something to say when the failure carries no words", () => {
    expect(actionErrorText(undefined, "zh")).toBe("操作没有完成，请重试");
    expect(actionErrorText(new Error(""), "en")).toBe("That didn't go through. Try again.");
  });
});
