import fs from "fs";
import path from "path";

export type SingleValueKey = "welcomeChannelId" | "roleApprovalChannelId";
export type MultiValueKey = "botCommandRoleIds";
export type GuildSettingKey = SingleValueKey | MultiValueKey;

export type GuildSettings = Partial<{
  welcomeChannelId: string;
  roleApprovalChannelId: string;
  botCommandRoleIds: string[];
}>;

const GUILD_SETTINGS_PATH = path.join(process.cwd(), "data", "guildSettings.json");
const guildSettings = new Map<string, GuildSettings>();

function ensureDirectory() {
  const dir = path.dirname(GUILD_SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function persist() {
  ensureDirectory();
  const obj: Record<string, GuildSettings> = {};
  for (const [guildId, settings] of guildSettings.entries()) {
    obj[guildId] = settings;
  }
  fs.writeFileSync(GUILD_SETTINGS_PATH, JSON.stringify(obj, null, 2), "utf8");
}

export function loadGuildSettingsFromDisk(): Record<string, GuildSettings> {
  try {
    if (!fs.existsSync(GUILD_SETTINGS_PATH)) return {};
    const raw = fs.readFileSync(GUILD_SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}") as Record<string, GuildSettings>;
    for (const [guildId, settings] of Object.entries(parsed)) {
      guildSettings.set(guildId, settings ?? {});
    }
    return parsed;
  } catch (error) {
    console.error("Failed to load guild settings:", error);
    return {};
  }
}

export function getGuildSettings(guildId: string): GuildSettings {
  return guildSettings.get(guildId) ?? {};
}

export function getBotCommandRoleIds(guildId: string): string[] {
  const settings = getGuildSettings(guildId);
  const roleIds = settings.botCommandRoleIds;
  return Array.isArray(roleIds) ? roleIds : [];
}

export function setGuildSetting(guildId: string, key: GuildSettingKey, value: string | string[] | undefined) {
  const existing = getGuildSettings(guildId);
  if (value === undefined) {
    const next = { ...existing };
    delete next[key];
    if (Object.keys(next).length === 0) guildSettings.delete(guildId);
    else guildSettings.set(guildId, next);
    persist();
    return;
  }

  guildSettings.set(guildId, { ...existing, [key]: value });
  persist();
}

export function setGuildSettings(guildId: string, updates: Partial<GuildSettings>) {
  const existing = getGuildSettings(guildId);
  const next = { ...existing, ...updates };
  Object.keys(next).forEach((key) => {
    const settingKey = key as GuildSettingKey;
    if (next[settingKey] === undefined) delete next[settingKey];
  });
  if (Object.keys(next).length === 0) guildSettings.delete(guildId);
  else guildSettings.set(guildId, next);
  persist();
}

export function clearGuildSettings() {
  guildSettings.clear();
  try {
    ensureDirectory();
    fs.writeFileSync(GUILD_SETTINGS_PATH, JSON.stringify({}, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to clear guild settings:", error);
  }
}

loadGuildSettingsFromDisk();
