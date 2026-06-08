import { strict as assert } from "node:assert";
import { test } from "node:test";

import { renderAgentAdminPage } from "../src/adminPage.ts";

test("Agent Admin page is served from static assets", () => {
  const html = renderAgentAdminPage();

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /OmniWork Agent Admin/);
  assert.match(html, /\/api\/status/);
  assert.match(html, /\/api\/connections/);
});
