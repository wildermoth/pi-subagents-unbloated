import type { JobRecord } from "./jobs.ts";

export interface Inbox {
  /** Ignores ids seen before (pending or delivered). */
  publish(r: JobRecord): void;
  /** All undelivered records in publish order; marks them delivered. */
  drain(): JobRecord[];
  /** Mid-turn read of one pending record; marks it delivered. */
  take(id: string): JobRecord | undefined;
  /** Undo a drain whose delivery failed; records go back first, undelivered. */
  requeue(records: JobRecord[]): void;
  readonly size: number;
  format(records: JobRecord[]): string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Cut to at most max bytes without splitting a UTF-8 sequence. */
function clip(s: string, max: number): { text: string; cut: boolean; total: number } {
  const b = enc.encode(s);
  if (b.length <= max) return { text: s, cut: false, total: b.length };
  let end = max;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return { text: dec.decode(b.subarray(0, end)), cut: true, total: b.length };
}

export function createInbox(opts: { onPublish?: () => void; maxTextBytes?: number } = {}): Inbox {
  const max = opts.maxTextBytes ?? 4096;
  const pending = new Map<string, JobRecord>();
  const seen = new Set<string>();

  const deliver = (r: JobRecord): JobRecord => {
    r.delivered = true;
    return r;
  };

  function formatOne(r: JobRecord): string {
    const res = r.result;
    const status = res?.failure ? `${r.state} (${res.failure.kind})` : r.state;
    const lines = [`[${r.id} ${r.agent}] ${status}`];
    if (res?.failure) lines.push(`error: ${res.failure.message}`);
    if (res?.text) {
      const c = clip(res.text, max);
      lines.push(c.text);
      if (c.cut) lines.push(`[truncated: showing ${enc.encode(c.text).length} of ${c.total} bytes]`);
      else if (res.truncated) lines.push("[truncated by runner]");
    }
    return lines.join("\n");
  }

  return {
    publish(r) {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      pending.set(r.id, r);
      opts.onPublish?.();
    },
    drain() {
      const out = [...pending.values()].map(deliver);
      pending.clear();
      return out;
    },
    take(id) {
      const r = pending.get(id);
      if (!r) return undefined;
      pending.delete(id);
      return deliver(r);
    },
    requeue(records) {
      const rest = [...pending.values()];
      pending.clear();
      for (const r of [...records, ...rest]) {
        r.delivered = false;
        pending.set(r.id, r);
      }
    },
    get size() {
      return pending.size;
    },
    format(records) {
      const head = `${records.length} subagent job${records.length === 1 ? "" : "s"} finished`;
      return [head, ...records.map(formatOne)].join("\n\n");
    },
  };
}
