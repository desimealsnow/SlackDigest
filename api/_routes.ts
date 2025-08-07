// api/_routes.ts
import fs from "fs";
import path from "path";

export default function handler(req, res) {
  const apiDir = path.join(process.cwd(), "api");
  const files: string[] = [];
  walk(apiDir, "");
  res.status(200).json(files.sort());

  function walk(dir: string, prefix: string) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const rel  = path.join(prefix, f);
      if (fs.statSync(full).isDirectory()) {
        walk(full, rel);
      } else if (f.endsWith(".ts") || f.endsWith(".js")) {
        files.push("/api/" + rel.replace(/\.background\.ts$|\.ts$|\.js$/,""));
      }
    }
  }
}
