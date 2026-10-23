import { ChatAccountUsage } from "./types";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000
    ? value : undefined;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function unixTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function durationLabel(minutes: number): string {
  const unit = (count: number, name: string): string => `${count} ${name}${count === 1 ? "" : "s"}`;
  if (minutes % 10080 === 0) return unit(minutes / 10080, "week");
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

/** The Claude SDK control reply is experimental: validate only the fields we display. */
export function claudeAccountUsage(raw: unknown): ChatAccountUsage | undefined {
  if (!record(raw) || raw.rate_limits_available !== true || !record(raw.rate_limits)) return undefined;
  const limits = raw.rate_limits;
  const windows: ChatAccountUsage["windows"] = [];
  const add = (source: unknown, label: string): void => {
    if (!record(source)) return;
    const usedPercent = percent(source.utilization);
    if (usedPercent === undefined) return;
    const resetsAt = isoTime(source.resets_at);
    windows.push({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  };
  add(limits.five_hour, "5 hours");
  add(limits.seven_day, "7 days");
  add(limits.seven_day_opus, "Opus · 7 days");
  add(limits.seven_day_sonnet, "Sonnet · 7 days");
  add(limits.seven_day_oauth_apps, "OAuth apps · 7 days");
  if (Array.isArray(limits.model_scoped)) {
    for (const item of limits.model_scoped.slice(0, 8)) {
      if (record(item) && typeof item.display_name === "string") add(item, `${item.display_name.slice(0, 60)} · 7 days`);
    }
  }
  add(limits.extra_usage, "Extra usage · monthly");
  return windows.length ? { checkedAt: new Date().toISOString(), windows } : undefined;
}

/** Read the window names and percentages from Codex's app-server rate-limit reply. */
export function codexAccountUsage(raw: unknown): ChatAccountUsage | undefined {
  if (!record(raw)) return undefined;
  const groups = raw.rateLimitsByLimitId;
  const byId: [string, unknown][] = record(groups) && Object.keys(groups).length
    ? Object.entries(groups) : [["codex", raw.rateLimits]];
  const windows: ChatAccountUsage["windows"] = [];
  for (const [id, value] of byId.slice(0, 8)) {
    if (!record(value)) continue;
    const name = typeof value.limitName === "string" && value.limitName.trim()
      ? value.limitName.trim().slice(0, 60) : id === "codex" ? "Codex" : id.slice(0, 60);
    for (const slot of ["primary", "secondary"] as const) {
      const window = value[slot];
      if (!record(window)) continue;
      const usedPercent = percent(window.usedPercent);
      if (usedPercent === undefined) continue;
      const duration = window.windowDurationMins;
      const period = typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0
        ? durationLabel(duration)
        : slot;
      const resetsAt = unixTime(window.resetsAt);
      windows.push({ label: `${name} · ${period}`, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  const access = raw.ordinaryUsageAllowed === true ? "allowed" as const
    : raw.ordinaryUsageAllowed === false ? "blocked" as const : undefined;
  return windows.length || access ? { checkedAt: new Date().toISOString(), windows, ...(access ? { access } : {}) } : undefined;
}
