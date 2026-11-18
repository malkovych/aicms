import { addModuleToFile } from "../config-edit.ts";
import { catalog, findCatalog } from "../modules/catalog.ts";
import { AicmsError } from "./errors.ts";
import { moduleManifest } from "./modules.ts";
import type { Kernel } from "./cms.ts";

/** A catalog module, by name, if it isn't installed yet. */
export function catalogEntry(k: Kernel, name: string) {
  const entry = findCatalog(name);
  if (!entry) throw new AicmsError("not_found", `No module "${name}" in the catalog. Available: ${catalog.map((c) => c.name).join(", ")}`);
  if (k.modules.some((m) => m.name === entry.name)) throw new AicmsError("invalid", `Module "${entry.name}" is already installed`);
  return entry;
}

/** Install an official module into the running kernel and, when the kernel came from a config file, write it there too. */
export async function installFromCatalog(k: Kernel, name: string) {
  const entry = catalogEntry(k, name);
  const def = entry.create();
  await k.installModule(def);
  let persisted = false;
  let note: string | undefined;
  if (k.configFile) {
    try {
      addModuleToFile(k.configFile, { name: entry.importName, from: "aicms/modules", isDefault: false, call: `${entry.importName}()` });
      persisted = true;
    } catch (e) {
      note = `Installed for this run, but aicms.config wasn't updated: ${e instanceof Error ? e.message : e}. Add ${entry.example} to modules by hand.`;
    }
  } else {
    note = `Installed for this run. Add ${entry.example} to modules in aicms.config to keep it.`;
  }
  return { module: entry.name, manifest: moduleManifest(def), persisted, ...(note ? { note } : {}) };
}
