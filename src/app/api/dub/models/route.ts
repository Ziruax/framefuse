import { NextResponse } from "next/server";

import { DUB_LANG_NAMES } from "@/lib/server/dub-langs";

export const runtime = "nodejs";

/**
 * Web dubbing "models" — the web provider has no model picker; the payload
 * exists so the frontend can share one transport shape with the Electron
 * flow. `langNames` feeds the Dubbing language dropdown.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    models: [],
    langNames: DUB_LANG_NAMES,
    provider: "web",
    web: true,
  });
}
