import fs from "node:fs";
import path from "node:path";

const RUNTIME_JS = path.resolve("node_modules/@codesandbox/sandpack-client/dist/clients/runtime/index.js");
const RUNTIME_MJS = path.resolve("node_modules/@codesandbox/sandpack-client/dist/clients/runtime/index.mjs");

function patchFile(filePath, isMjs) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[patch-sandpack] File not found: ${filePath}`);
    return;
  }

  let code = fs.readFileSync(filePath, "utf8");
  let modified = false;

  // 1. Ensure this.iframe is preserved in IFrameProtocol constructor
  if (!code.includes("this.iframe = iframe;")) {
    const target = "this.frameWindow = iframe.contentWindow;";
    if (code.includes(target)) {
      code = code.replace(
        target,
        "this.iframe = iframe;\n        this.frameWindow = iframe ? iframe.contentWindow : null;"
      );
      modified = true;
    }
  }

  // 2. Patch IFrameProtocol.prototype.register
  if (!code.includes("IFrameProtocol.prototype.register = function () {\n        var win =")) {
    const registerRegex = /IFrameProtocol\.prototype\.register = function \(\) \{[\s\S]*?this\.frameWindow\.postMessage\(\{[\s\S]*?\}, this\.origin\);[\s\S]*?\};/;
    if (registerRegex.test(code)) {
      code = code.replace(
        registerRegex,
        `IFrameProtocol.prototype.register = function () {
        var win = (this.iframe && this.iframe.contentWindow) || this.frameWindow;
        if (!win) {
            return;
        }
        win.postMessage({
            type: "register-frame",
            origin: document.location.origin,
            id: this.channelId,
        }, "*");
    };`
      );
      modified = true;
    }
  }

  // 3. Patch IFrameProtocol.prototype.dispatch
  if (!code.includes("IFrameProtocol.prototype.dispatch = function (message) {\n        var win =")) {
    const assignFn = isMjs ? "__assign" : "utils.__assign";
    const dispatchRegex = new RegExp(
      `IFrameProtocol\\.prototype\\.dispatch = function \\(message\\) \\{[\\s\\S]*?this\\.frameWindow\\.postMessage\\(${assignFn.replace('.', '\\.')}\\(\\{ \\$id: this\\.channelId, codesandbox: true \\}, message\\), this\\.origin\\);[\\s\\S]*?\\};`
    );
    if (dispatchRegex.test(code)) {
      code = code.replace(
        dispatchRegex,
        `IFrameProtocol.prototype.dispatch = function (message) {
        var win = (this.iframe && this.iframe.contentWindow) || this.frameWindow;
        if (!win) {
            return;
        }
        win.postMessage(${assignFn}({ $id: this.channelId, codesandbox: true }, message), "*");
    };`
      );
      modified = true;
    }
  }

  // 4. Patch IFrameProtocol.prototype.eventListener
  const eventListenerTarget = "if (evt.source !== this.frameWindow) {\n            return;\n        }";
  if (code.includes(eventListenerTarget)) {
    code = code.replace(
      eventListenerTarget,
      `var win = (this.iframe && this.iframe.contentWindow) || this.frameWindow;
        if (evt.source !== win && evt.source !== this.frameWindow) {
            return;
        }`
    );
    modified = true;
  }

  // 5. Patch createBundlerURL to resolve relative bundlerURL
  if (!code.includes('bundlerURL.startsWith("/")')) {
    const createBundlerTarget = `if (this.options.bundlerURL) {\n            return bundlerURL;\n        }`;
    if (code.includes(createBundlerTarget)) {
      code = code.replace(
        createBundlerTarget,
        `if (this.options.bundlerURL) {
            if (bundlerURL.startsWith("/") && typeof window !== "undefined" && window.location) {
                return new URL(bundlerURL, window.location.origin).toString();
            }
            return bundlerURL;
        }`
      );
      modified = true;
    }
  }

  // 6. Patch setLocationURLIntoIFrame to be safe with relative URLs and location.replace errors
  if (!code.includes("bundlerObj.pathname = basePath")) {
    const setLocationRegex = /SandpackRuntime\.prototype\.setLocationURLIntoIFrame = function \(\) \{[\s\S]*?this\.iframe\.src = urlSource;[\s\S]*?\};/;
    if (setLocationRegex.test(code)) {
      code = code.replace(
        setLocationRegex,
        `SandpackRuntime.prototype.setLocationURLIntoIFrame = function () {
        var _a;
        var urlSource;
        try {
            var base = typeof window !== "undefined" && window.location ? window.location.origin : undefined;
            var fullUrl = (this.bundlerURL && this.bundlerURL.startsWith("/")) ? new URL(this.bundlerURL, base).toString() : this.bundlerURL;
            if (this.options.startRoute && this.options.startRoute !== "/") {
                var bundlerObj = new URL(fullUrl);
                var basePath = bundlerObj.pathname.replace(/\\/$/, "");
                bundlerObj.pathname = basePath + (this.options.startRoute.startsWith("/") ? this.options.startRoute : "/" + this.options.startRoute);
                urlSource = bundlerObj.toString();
            } else {
                urlSource = fullUrl;
            }
        } catch (_err) {
            urlSource = this.bundlerURL;
        }
        try {
            (_a = this.iframe.contentWindow) === null || _a === void 0 ? void 0 : _a.location.replace(urlSource);
        } catch (_err) {}
        this.iframe.src = urlSource;
    };`
      );
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, code, "utf8");
    console.log(`[patch-sandpack] Successfully patched ${path.basename(filePath)}`);
  } else {
    console.log(`[patch-sandpack] Already patched or up to date: ${path.basename(filePath)}`);
  }
}

function run() {
  console.log("[patch-sandpack] Running Sandpack client patches...");
  patchFile(RUNTIME_JS, false);
  patchFile(RUNTIME_MJS, true);
  console.log("[patch-sandpack] Complete.");
}

run();
