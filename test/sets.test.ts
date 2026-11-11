import { describe, expect, it } from "vitest";
import { DECISION_MAKER_TITLES, decisionMakersSearch } from "../src/sets.js";

describe("decision-maker searches", () => {
    it("frames discovery around the company and product being sold", () => {
        const search = decisionMakersSearch({ company: "Acme", product: "an AI sales copilot" });
        expect(search.query).toContain("AI sales copilot");
        expect(search.filters).toEqual({ company: "Acme" });
        expect(search.criteria).toEqual(["Currently works at Acme", "Holds a role that would evaluate, buy, or influence the purchase of an AI sales copilot"]);
    });

    it("adds requested roles as a criterion", () => {
        const search = decisionMakersSearch({ company: "Acme", product: "a CRM", titles: ["VP Sales", "CRO"] });
        expect(search.query).toContain("such as VP Sales, CRO");
        expect(search.criteria[2]).toBe("Role matches or is equivalent to one of: VP Sales, CRO");
    });

    it("keeps every criterion within the Sets 500-character limit at the input maximums", () => {
        const search = decisionMakersSearch({
            company: "c".repeat(200),
            product: "p".repeat(300),
            titles: Array.from({ length: DECISION_MAKER_TITLES.max }, () => "t".repeat(DECISION_MAKER_TITLES.maxLength)),
        });
        expect(search.criteria.every((criterion) => criterion.length <= 500)).toBe(true);
    });
});
