import { describe, expect, it } from "vitest";
import { marketOfUrl } from "../src/markets/hosts";

describe("marketOfUrl", () => {
  it("tells which market's site a tab is on", () => {
    expect(marketOfUrl("https://www.cardmarket.com/it/Magic/Stock/Offers")).toBe("cm");
    expect(marketOfUrl("https://www.cardtrader.com/en-EU/users/x")).toBe("ct");
  });

  it("is null elsewhere, and for what Chrome hides or can't parse", () => {
    expect(marketOfUrl("https://cardmarket.com.evil.example/")).toBeNull();
    expect(marketOfUrl("http://www.cardmarket.com/")).toBeNull();
    expect(marketOfUrl("http://localhost:5173/")).toBeNull();
    expect(marketOfUrl("chrome://extensions")).toBeNull();
    expect(marketOfUrl(undefined)).toBeNull();
    expect(marketOfUrl("not a url")).toBeNull();
  });
});
