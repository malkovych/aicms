import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { Config } from "./config.ts";
import { isModel } from "./schema/model.ts";

const CONFIG_FILES = ["aicms.config.ts", "aicms.config.mts", "aicms.config.js", "aicms.config.mjs"];

/** Our own entry file, so projects without a local `aicms` install still resolve `import ... from "aicms"`. */
function selfEntry(): string {
  const js = fileURLToPath(new URL("./index.js", import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL("./index.ts", import.meta.url));
}

function resolvesLocally(root: string): boolean {
  try {
    createRequire(join(root, "noop.js")).resolve("aicms");
    return true;
  } catch {
    return false;
  }
}

export interface Project {
  config: Config;
  root: string;
  file: string;
}

/** Load aicms.config.ts (no build step) and, unless it lists models, every file in ./models. */
export async function loadProject(cwd: string, explicit?: string): Promise<Project> {
  const file = explicit ? resolve(cwd, explicit) : CONFIG_FILES.map((n) => join(cwd, n)).find((p) => existsSync(p));
  if (!file || !existsSync(file)) throw new Error(`No aicms.config.ts in ${cwd}. Run "aicms init" to create a project.`);
  const root = dirname(file);
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
    ...(resolvesLocally(root) ? {} : { alias: { aicms: selfEntry() } }),
  });
  let config = (await jiti.import(file, { default: true })) as Config;
  if (!config || typeof config !== "object") throw new Error(`${file} must export a config: export default defineConfig({ ... })`);

  if (!config.models) {
    const dir = join(root, "models");
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => /\.(ts|mts|js|mjs)$/.test(f) && !f.endsWith(".d.ts")).sort()
      : [];
    const models = [];
    for (const f of files) {
      const m = await jiti.import(join(dir, f), { default: true });
      if (!isModel(m)) throw new Error(`models/${f} must export default defineModel({ ... })`);
      models.push(m);
    }
    config = { ...config, models };
  }
  return { config, root, file };
}
