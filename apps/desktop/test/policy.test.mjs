import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePolicy } from "../dist/main/policy.js";
import { launchOptions } from "../dist/main/runtime.js";

const ready = (url) => JSON.stringify({ url });
const token = "a".repeat(43);

test("accepts only the sidecar's loopback address with a capability", () => {
  const url = WorkspacePolicy.readyURL(ready(`http://127.0.0.1:52455/#desktop=${token}`));
  assert.equal(url.port, "52455");
  for (const bad of [
    `http://localhost:52455/#desktop=${token}`,
    `https://127.0.0.1:52455/#desktop=${token}`,
    `http://127.0.0.1:52455/x#desktop=${token}`,
    `http://127.0.0.1:52455/?a=1#desktop=${token}`,
    `http://user@127.0.0.1:52455/#desktop=${token}`,
    `http://127.0.0.1:52455/#desktop=short`,
    `http://127.0.0.1:52455/`,
  ]) assert.throws(() => WorkspacePolicy.readyURL(ready(bad)), bad);
  assert.throws(() => WorkspacePolicy.readyURL("not json"));
});

test("only the workspace origin's main frame reaches the bridge", () => {
  const policy = new WorkspacePolicy(new URL(`http://127.0.0.1:52455/#desktop=${token}`));
  assert.ok(policy.allowsBridge("http://127.0.0.1:52455/", true));
  assert.ok(!policy.allowsBridge("http://127.0.0.1:52455/", false));
  assert.ok(!policy.allowsBridge("http://localhost:52455/", true));
  assert.ok(!policy.allowsBridge("http://127.0.0.1:52456/", true));
  assert.ok(!policy.allowsBridge("about:srcdoc", true));
  assert.ok(!policy.allowsBridge(undefined, true));
});

test("previews and viewer frames may load, but are not trusted", () => {
  const policy = new WorkspacePolicy(new URL(`http://127.0.0.1:52455/#desktop=${token}`));
  assert.ok(policy.isPreview("http://localhost:52455/preview/x"));
  assert.ok(!policy.isTrusted("http://localhost:52455/preview/x"));
  assert.ok(policy.allowsSubframe("about:srcdoc"));
  assert.ok(policy.allowsSubframe("blob:null/abc"));
  assert.ok(policy.allowsSubframe("blob:http://127.0.0.1:52455/abc"));
  assert.ok(!policy.allowsSubframe("blob:http://evil.example/abc"));
  assert.ok(!policy.allowsSubframe("file:///etc/passwd"));
});

test("external links never open local files or loopback services", () => {
  assert.ok(WorkspacePolicy.externalURL("https://linkshell.itool.tech/"));
  for (const bad of ["file:///etc/hosts", "http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]/", "http://0.0.0.0/",
    "http://169.254.169.254/latest", "https://user:pass@example.com/", "javascript:alert(1)", "http://a.localhost/"]) {
    assert.ok(!WorkspacePolicy.externalURL(bad), bad);
  }
});

test("reads what the Swift launcher and `linkshell app` pass on", () => {
  const options = launchOptions(["/x/LinkShell Desktop", "--dashboard", "--home", "/tmp/h", "--cli-node", "/n", "--cli-arg", "--a", "--cli-arg", "--b", "--cli-script", "/s.js", "--check-updates"]);
  assert.deepEqual(options, { home: "/tmp/h", cliNode: "/n", cliScript: "/s.js", cliArgs: ["--a", "--b"], cliPath: undefined, checkUpdates: true, hidden: false });
  assert.equal(launchOptions(["x"]).checkUpdates, false);
  // Windows starts it at sign-in with --hidden (the Run entry): no window until it is asked for.
  assert.equal(launchOptions(["LinkShell.exe", "--hidden"]).hidden, true);
});
