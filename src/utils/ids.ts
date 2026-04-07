import { randomUUID } from "crypto";

export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
