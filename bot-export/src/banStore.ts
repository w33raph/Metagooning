import fs from "fs";
import path from "path";

export type BanEntry = {
  moderatorId: string;
  targetId: string;
  status: "failed" | "bypassed" | "format" | "clean";
  timestamp: string;
  guildId?: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_PATH = path.join(DATA_DIR, "banlogs.json");
const LB_PATH = path.join(DATA_DIR, "leaderboard.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, JSON.stringify([]));
}

function load(): BanEntry[] {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as BanEntry[];
  } catch (e) {
    return [];
  }
}

function save(entries: BanEntry[]) {
  ensure();
  fs.writeFileSync(DATA_PATH, JSON.stringify(entries, null, 2), "utf8");
}

function loadLeaderboardMap() {
  if (!fs.existsSync(LB_PATH)) return {} as Record<string, { channelId: string; messageId: string }>;
  try { return JSON.parse(fs.readFileSync(LB_PATH, "utf8")); } catch { return {} as Record<string, { channelId: string; messageId: string }>; }
}

function saveLeaderboardMap(map: Record<string, { channelId: string; messageId: string }>) {
  ensure();
  fs.writeFileSync(LB_PATH, JSON.stringify(map, null, 2), "utf8");
}

function setLeaderboardMessage(guildId: string, channelId: string, messageId: string) {
  const map = loadLeaderboardMap();
  map[guildId] = { channelId, messageId };
  saveLeaderboardMap(map);
}

function getLeaderboardMessage(guildId: string) {
  const map = loadLeaderboardMap();
  return map[guildId] ?? null;
}

function getAllLeaderboardMappings() {
  return loadLeaderboardMap();
}

function addBan(moderatorId: string, targetId: string, status: "failed" | "bypassed" | "format" | "clean", guildId?: string) {
  const entries = load();
  entries.push({ moderatorId, targetId, status, timestamp: new Date().toISOString(), guildId });
  save(entries);
}

function getBansByModerator(moderatorId: string, guildId?: string) {
  return load().filter((e) => e.moderatorId === moderatorId && (!guildId || e.guildId === guildId));
}

function getLeaderboard(guildId?: string) {
  const entries = load().filter((e) => !guildId || e.guildId === guildId);
  const map = new Map<string, { total: number; failed: number; bypassed: number; format: number; clean: number }>();
  for (const e of entries) {
    const cur = map.get(e.moderatorId) ?? { total: 0, failed: 0, bypassed: 0, format: 0, clean: 0 };
    cur.total += 1;
    if (e.status === "failed") cur.failed += 1;
    if (e.status === "bypassed") cur.bypassed += 1;
    if (e.status === "format") cur.format += 1;
    if (e.status === "clean") cur.clean += 1;
    map.set(e.moderatorId, cur);
  }
  return Array.from(map.entries())
    .map(([moderatorId, stats]) => ({ moderatorId, ...stats }))
    .sort((a, b) => b.total - a.total);
}

export default { addBan, getBansByModerator, getLeaderboard, setLeaderboardMessage, getLeaderboardMessage, getAllLeaderboardMappings };
