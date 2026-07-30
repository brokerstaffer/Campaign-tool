import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { parseDailySeries, selectScope } from "./daily-series.ts";

describe("selectScope", () => {
  const base = { from: "2026-07-01", to: "2026-07-30" };

  test("no filters uses the workspace roll-up", () => {
    assert.equal(selectScope(base), "workspace");
  });

  test("exactly one campaign uses the per-campaign endpoint", () => {
    assert.equal(selectScope({ ...base, campaignIds: [7] }), "campaign");
  });

  test("several campaigns fall back to campaign-events", () => {
    assert.equal(selectScope({ ...base, campaignIds: [7, 9] }), "filtered");
  });

  test("a sender filter always forces campaign-events", () => {
    // Only /campaign-events/stats accepts sender_email_ids[].
    assert.equal(
      selectScope({ ...base, campaignIds: [7], senderEmailIds: [3] }),
      "filtered",
    );
    assert.equal(selectScope({ ...base, senderEmailIds: [3] }), "filtered");
  });
});

describe("parseDailySeries", () => {
  const response = {
    data: [
      {
        label: "Sent",
        color: "#3B82F6",
        dates: [
          ["2026-07-01", 1200],
          ["2026-07-02", 980],
        ] as Array<[string, number]>,
      },
      {
        label: "Replied",
        color: "#f54842",
        dates: [["2026-07-01", 14]] as Array<[string, number]>,
      },
    ],
  };

  test("flattens the envelope into one row per (date, metric)", () => {
    const points = parseDailySeries(response, 0);
    assert.equal(points.length, 3);
    assert.deepEqual(points[0], {
      campaignId: 0,
      date: "2026-07-01",
      metric: "sent",
      value: 1200,
    });
  });

  test("maps EmailBison labels to our metric keys", () => {
    const metrics = parseDailySeries(response, 0).map((p) => p.metric);
    assert.ok(metrics.includes("sent"));
    assert.ok(metrics.includes("replies")); // "Replied" -> replies
  });

  test("stamps the campaign id onto every row", () => {
    const points = parseDailySeries(response, 42);
    assert.ok(points.every((p) => p.campaignId === 42));
  });

  test("skips an unmapped label instead of writing garbage", () => {
    const withUnknown = {
      data: [
        ...response.data,
        {
          label: "Clicked",
          color: "#000",
          dates: [["2026-07-01", 5]] as Array<[string, number]>,
        },
      ],
    };
    const points = parseDailySeries(withUnknown, 0);
    assert.equal(points.length, 3); // the three known rows, not four
  });

  test("skips a malformed tuple rather than emitting NaN", () => {
    const malformed = {
      data: [
        {
          label: "Sent",
          color: "#3B82F6",
          dates: [
            ["2026-07-01", 10],
            ["2026-07-02", "oops"],
          ] as unknown as Array<[string, number]>,
        },
      ],
    };
    const points = parseDailySeries(malformed, 0);
    assert.equal(points.length, 1);
    assert.ok(Number.isFinite(points[0].value));
  });

  test("an empty response is an empty array, not a throw", () => {
    assert.deepEqual(parseDailySeries({ data: [] }, 0), []);
  });
});
