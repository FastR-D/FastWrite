import { expect, test } from "bun:test";
import { MetricsRegistry } from "./metrics";

test("metrics registry exposes bounded counters and Prometheus output", () => {
  const metrics = new MetricsRegistry(); metrics.observe("GET", "/api/health", 200); metrics.observe("GET", "/api/health", 500);
  expect(metrics.snapshot()).toMatchObject({ requests: 2, errors: 1, status: { "200": 1, "500": 1 } });
  expect(metrics.prometheus()).toContain("fastwrite_http_requests_total 2");
  expect(metrics.prometheus()).toContain('fastwrite_http_responses_total{status="500"} 1');
});
