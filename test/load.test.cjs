/**
 * Load check: requires the built `main.js` with a stubbed `obsidian` module to prove
 * the bundle evaluates cleanly at module scope (no missing globals, no eager Node
 * built-in access — important for mobile, where `require("http")` must stay lazy).
 */
const Module = require("module");
const path = require("path");

const cache = Object.create(null);
const stub = new Proxy(cache, {
  get(target, key) {
    if (typeof key !== "string") return undefined;
    if (key === "Platform") return { isDesktopApp: false, isMobileApp: true, isMobile: true };
    if (key === "normalizePath") return (value) => String(value).replace(/\\/g, "/");
    if (key === "setIcon") return () => undefined;
    if (key === "moment") return () => ({ format: (fmt) => fmt });
    if (key === "requestUrl") return async () => ({ status: 200, json: {}, text: "" });
    if (key === "MarkdownRenderer") return { render: async () => undefined };
    if (!(key in target)) target[key] = class Stub {};
    return target[key];
  },
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") return stub;
  // The MCP server must only touch Node's http module lazily, when it starts —
  // otherwise the bundle would crash on mobile.
  if (request === "http" || request === "node:http") {
    throw new Error("bundle required node:http at load time");
  }
  return originalLoad.call(this, request, parent, isMain);
};

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
  }
}

const bundlePath = path.join(__dirname, "..", "main.js");
const loaded = require(bundlePath);
const PluginClass = loaded.default || loaded;

check("bundle exports a plugin class", typeof PluginClass === "function", typeof PluginClass);
check("bundle loads without eager require('http')", true);
check("onload exists", typeof PluginClass.prototype.onload === "function");
check("onunload exists", typeof PluginClass.prototype.onunload === "function");
check("manifest id matches the bundle", require("../manifest.json").id === "ai-connected");

process.stdout.write(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures === 0 ? "all" : failures} load checks\n\n`);
if (failures > 0) process.exitCode = 1;
