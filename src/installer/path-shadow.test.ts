import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findShadowingSummer, shadowWarning, type PathShadowDeps } from "./path-shadow.js";

/** A fake disk: files with contents, and links (path -> target). */
function disk(files: Record<string, string>, links: Record<string, string> = {}): PathShadowDeps {
  return {
    exists: (path) => path in files || path in links,
    realpath: (path) => links[path] ?? path,
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
    platform: "darwin",
    packageRoot: "/npx/abc/node_modules/summer-engine",
  };
}

const pkg = (version: string) => JSON.stringify({ name: "summer-engine", version });
const npx = {
  "/npx/abc/node_modules/summer-engine/package.json": pkg("4.8.0"),
  "/npx/abc/node_modules/summer-engine/dist/bin/summer.js": "",
};
const npxLink = { "/npx/abc/node_modules/.bin/summer": "/npx/abc/node_modules/summer-engine/dist/bin/summer.js" };
const globalOld = {
  "/usr/local/lib/node_modules/summer-engine/package.json": pkg("3.1.0"),
  "/usr/local/lib/node_modules/summer-engine/dist/bin/summer.js": "",
};
const globalLink = { "/usr/local/bin/summer": "/usr/local/lib/node_modules/summer-engine/dist/bin/summer.js" };
const path = (...dirs: string[]) => ({ PATH: dirs.join(delimiter) });

describe("findShadowingSummer", () => {
  it("names an older global summer behind npx's own copy", () => {
    const found = findShadowingSummer("4.8.0", path("/npx/abc/node_modules/.bin", "/usr/local/bin"), disk({ ...npx, ...globalOld }, { ...npxLink, ...globalLink }));
    expect(found).toEqual({ path: "/usr/local/bin/summer", version: "3.1.0", homebrew: false });
    expect(shadowWarning(found!, "4.8.0")).toContain("npm install -g summer-engine@latest");
  });

  it("says nothing when the global summer is as new, or there is none", () => {
    const current = { ...globalOld, "/usr/local/lib/node_modules/summer-engine/package.json": pkg("4.8.0") };
    expect(findShadowingSummer("4.8.0", path("/npx/abc/node_modules/.bin", "/usr/local/bin"), disk({ ...npx, ...current }, { ...npxLink, ...globalLink }))).toBeNull();
    expect(findShadowingSummer("4.8.0", path("/npx/abc/node_modules/.bin", "/usr/bin"), disk(npx, npxLink))).toBeNull();
  });

  it("says nothing when the first summer is another program", () => {
    const other = { "/opt/bin/summer": "#!/bin/sh" };
    expect(findShadowingSummer("4.8.0", path("/opt/bin", "/usr/local/bin"), disk({ ...other, ...globalOld }, globalLink))).toBeNull();
  });

  it("tells a Homebrew install to upgrade with brew", () => {
    const cellar = "/opt/homebrew/Cellar/summer/3.1.0/libexec/lib/node_modules/summer-engine";
    const found = findShadowingSummer(
      "4.8.0",
      path("/opt/homebrew/bin"),
      disk({ [join(cellar, "package.json")]: pkg("3.1.0"), [join(cellar, "dist/bin/summer.js")]: "" }, { "/opt/homebrew/bin/summer": join(cellar, "dist/bin/summer.js") })
    );
    expect(found?.homebrew).toBe(true);
    expect(shadowWarning(found!, "4.8.0")).toContain("brew upgrade summerengine/tap/summer");
  });
});
