// SPDX-License-Identifier: AGPL-3.0-or-later

/** Common MIME type to file extension mapping. */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
};

/** Get file extension from MIME type. Returns "bin" if unknown. */
export function extensionFromMime(mimeType?: string): string {
  if (!mimeType) return "bin";
  return MIME_TO_EXT[mimeType] ?? mimeType.split("/")[1] ?? "bin";
}
