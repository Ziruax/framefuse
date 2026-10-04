import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
  MAX_FILE_BYTES,
  MAX_UPLOAD_FILES,
  TranscribeFailure,
  transcribeDubUploads,
} from "@/lib/server/dub-transcribe";
import type { TranscribeUpload } from "@/lib/server/dub-transcribe";

export const runtime = "nodejs";
export const maxDuration = 300;

interface MetaEntry {
  startMs: number | null;
  endMs: number | null;
}

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Sanitize an uploaded filename down to a safe extension for ffmpeg probing. */
function safeExtension(name: string): string {
  const ext = path.extname(name || "").replace(/^\./, "");
  if (!/^[A-Za-z0-9]{1,8}$/.test(ext)) return "";
  return `.${ext.toLowerCase()}`;
}

/** Parse + validate the optional `meta` timeline JSON. */
function parseMeta(raw: unknown, fileCount: number): (MetaEntry | null)[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  if (parsed.length !== fileCount) return [];
  const out: (MetaEntry | null)[] = [];
  for (const entry of parsed) {
    if (entry === null || entry === undefined) {
      out.push(null);
      continue;
    }
    if (typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const startMs =
      e.startMs === undefined || e.startMs === null
        ? null
        : typeof e.startMs === "number" && Number.isFinite(e.startMs) && e.startMs >= 0
          ? e.startMs
          : Number.NaN;
    const endMs =
      e.endMs === undefined || e.endMs === null
        ? null
        : typeof e.endMs === "number" && Number.isFinite(e.endMs)
          ? e.endMs
          : Number.NaN;
    if (startMs === Number.NaN || endMs === Number.NaN) return [];
    if (startMs !== null && endMs !== null && endMs <= startMs) return [];
    out.push({ startMs, endMs });
  }
  return out;
}

export async function POST(req: NextRequest) {
  let workDir: string | null = null;
  try {
    // ---- multipart parse + guards ----
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return bad("Request must be multipart/form-data with a `files` field", 400);
    }
    const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f instanceof File);
    if (files.length === 0) {
      return bad("At least one file is required in the `files` field", 400);
    }
    if (files.length > MAX_UPLOAD_FILES) {
      return bad(`Too many files — the limit is ${MAX_UPLOAD_FILES}`, 400);
    }
    for (let i = 0; i < files.length; i++) {
      if (files[i].size > MAX_FILE_BYTES) {
        return bad(
          `File ${i + 1} (${files[i].name || "unnamed"}) exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit`,
          413,
        );
      }
    }

    const meta = parseMeta(form.get("meta"), files.length);
    if (meta !== null && meta.length === 0) {
      return bad(
        "`meta` must be a JSON array like [{\"startMs\":0,\"endMs\":12000}] matching the file count",
        400,
      );
    }

    // v1.27: transcription engine (Settings tab) — "groq" (Whisper) or
    // "builtin" (cloud ASR). The Groq key rides the request; it is never
    // persisted server-side.
    const formProvider = String(form.get("provider") ?? "builtin");
    const provider = formProvider === "groq" ? "groq" : "builtin";
    const groqKey = String(form.get("groqKey") ?? "").trim();
    const groqModelRaw = String(form.get("groqModel") ?? "").trim();
    const groqModel = ["whisper-large-v3", "whisper-large-v3-turbo"].includes(groqModelRaw)
      ? groqModelRaw
      : "whisper-large-v3-turbo";
    const sourceLanguage = String(form.get("sourceLanguage") ?? "auto").trim().slice(0, 8) || "auto";
    if (provider === "groq" && !groqKey) {
      return bad("A Groq API key is required for Groq Whisper transcription", 400);
    }

    // ---- save uploads into a fresh temp dir ----
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-dub-"));
    const uploads: TranscribeUpload[] = [];
    for (let i = 0; i < files.length; i++) {
      const ext = safeExtension(files[i].name);
      const uploadPath = path.join(workDir, `upload${i}${ext}`);
      fs.writeFileSync(uploadPath, Buffer.from(await files[i].arrayBuffer()));
      const m = meta ? meta[i] : null;
      uploads.push({
        path: uploadPath,
        startMs: m ? m.startMs : null,
        endMs: m ? m.endMs : null,
      });
    }

    const result = await transcribeDubUploads(workDir, uploads, {
      provider,
      groqKey,
      groqModel,
      sourceLanguage,
    });
    return NextResponse.json({
      ...result,
      providerUsed: provider === "groq" && groqKey ? "groq" : "builtin",
      realWordTimings: provider === "groq" && !!groqKey,
    });
  } catch (err) {
    if (err instanceof TranscribeFailure) {
      return bad(err.message, err.status);
    }
    const message = err instanceof Error ? err.message : "Transcription failed";
    return bad(message, 500);
  } finally {
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
