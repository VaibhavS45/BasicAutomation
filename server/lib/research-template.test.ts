import { describe, expect, it } from "vitest";
import { buildCompanyResearchPrompt, parseBriefUrl } from "./research-template.js";

describe("research template", () => {
  it("extracts a Gmail-searchable domain and fills the three-token prompt", () => {
    const brief = buildCompanyResearchPrompt("https://www.acme.com/pricing");
    expect(brief.domain).toBe("acme.com");
    expect(brief.prompt).toContain("https://www.acme.com/pricing");
    expect(brief.prompt).toContain("from:acme.com");
    expect(brief.prompt).toContain("@gmail");
    expect(brief.prompt).toContain("@browser");
    expect(brief.prompt).toContain("@notion");
    expect(brief.prompt).toContain("untrusted data");
  });

  it("rejects non-URLs and non-http schemes", () => {
    expect(() => parseBriefUrl("acme")).toThrow(/Not a URL/);
    expect(() => parseBriefUrl("ftp://acme.com")).toThrow(/http/);
  });
});
