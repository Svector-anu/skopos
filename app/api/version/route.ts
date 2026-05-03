import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

export function GET() {
  let buildId = "dev";
  try {
    buildId = readFileSync(join(process.cwd(), ".next/BUILD_ID"), "utf8").trim();
  } catch {
    // dev mode — no BUILD_ID file
  }
  return Response.json({ buildId });
}
