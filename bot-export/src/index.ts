import path from "path";
import fs from "fs";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  type GuildMember,
  type Guild,
  type Message,
  type Role,
} from "discord.js";
import banStore from "./banStore";
import { resolveWelcomeChannel } from "./welcome";
import { buildRoleSelectionOptions, formatRequestedRoles } from "./roleRequestUi";
import { createBotProfileEmbed, createStandardEmbed } from "./utils/embed";

const log = {
  info:  (...a: unknown[]) => console.log("[INFO]", ...a),
  warn:  (...a: unknown[]) => console.warn("[WARN]", ...a),
  error: (...a: unknown[]) => console.error("[ERROR]", ...a),
};

const PREFIX       = process.env["COMMAND_PREFIX"]        || "!";
const MOD_ROLE_NAME = process.env["MODERATOR_ROLE_NAME"]  || "moderator";
const MOD_ROLE_ID   = process.env["MODERATOR_ROLE_ID"]    || "1461842547990200585";
const APPROVAL_CH   = process.env["ROLE_APPROVAL_CHANNEL_ID"] || "1523555738004226220";
const WELCOME_CH    = process.env["WELCOME_CHANNEL_ID"]   || "1522792076180324434";
const TOKEN         = process.env["DISCORD_TOKEN"];
const AUTO_GRANT_INVITE_CODE = process.env["AUTO_GRANT_INVITE_CODE"] || "kngscreenshare";
const AUTO_GRANT_ROLE_ID = process.env["AUTO_GRANT_ROLE_ID"] || "1527304379990937600";

if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set — exiting.");
  process.exit(1);
}

const REQUESTABLE_ROLE_IDS = [
  "1522793232755331192", // SS
  "1522793061141184512", // Generic
  "1528702196902789191", // AntiBypass
  "1522793156557541466", // DMA
];

const BAN_SUBMIT_ROLE_ID = "1522793232755331192";
const BAN_LOG_CHANNEL_ID = process.env["BAN_LOG_CHANNEL_ID"] || "1535921062154600500";
// Prefer this channel for leaderboard updates when no env var is configured
const BAN_LEADERBOARD_CHANNEL_ID = process.env["BAN_LEADERBOARD_CHANNEL_ID"] || "1523996882374885476";
const DEDICATED_BAN_LOG_CHANNEL_ID = process.env["DEDICATED_BAN_LOG_CHANNEL_ID"] || "1524034321575313490";

const pendingRequests = new Map<
  string,
  { userId: string; roleIds: string[]; roleNames: string[]; nickname: string; inGameId: string; approvalChannelId: string }
>();
const PENDING_PATH = path.join(process.cwd(), "data", "pendingRequests.json");
const TIMEOUT_LOG_PATH = path.join(process.cwd(), "data", "timeoutLogChannels.json");
const AUDIT_LOG_PATH = path.join(process.cwd(), "data", "audit.log");

function loadPendingRequestsFromDisk() {
  try {
    if (!fs.existsSync(PENDING_PATH)) return;
    const raw = fs.readFileSync(PENDING_PATH, "utf8");
    const obj = JSON.parse(raw || "{}");
    for (const [k, v] of Object.entries(obj)) {
      pendingRequests.set(k, v as any);
    }
    console.log("Loaded pendingRequests from disk:", Object.keys(obj).length);
  } catch (e) { console.error("Failed to load pendingRequests:", e); }
}

function loadTimeoutLogChannels(): Record<string, string> {
  try {
    if (!fs.existsSync(TIMEOUT_LOG_PATH)) return {};
    const raw = fs.readFileSync(TIMEOUT_LOG_PATH, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) { console.error("Failed to load timeout log channels:", e); return {}; }
}

function saveTimeoutLogChannels(obj: Record<string, string>) {
  try {
    const dir = path.dirname(TIMEOUT_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TIMEOUT_LOG_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) { console.error("Failed to save timeout log channels:", e); }
}

const timeoutLogChannels = loadTimeoutLogChannels();

function appendAuditLog(line: string) {
  try {
    const dir = path.dirname(AUDIT_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch (e) { console.error("Failed to write audit log:", e); }
}

function savePendingRequestsToDisk() {
  try {
    const obj: Record<string, any> = {};
    for (const [k, v] of pendingRequests.entries()) obj[k] = v;
    const dir = path.dirname(PENDING_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PENDING_PATH, JSON.stringify(obj, null, 2), "utf8");
      console.log("Saved pendingRequests to disk:", Object.keys(obj).length);
  } catch (e) { console.error("Failed to save pendingRequests:", e); }
}

// Load existing pending requests (if any) on startup
loadPendingRequestsFromDisk();
const pendingRoleMetadata = new Map<
  string,
  { userId: string; nickname: string; inGameId: string; guildId: string }
>();
const pendingScanLogs = new Map<string, { moderatorId: string; targetId: string; guildId: string }>();
const guildInviteCache = new Map<string, any>();

// Security: rate-limit moderator actions to prevent mass role changes / nuking
const SECURITY_ACTION_THRESHOLD = parseInt(process.env["SECURITY_ACTION_THRESHOLD"] || "10"); // actions
const SECURITY_ACTION_WINDOW_MS = parseInt(process.env["SECURITY_ACTION_WINDOW_MS"] || String(60 * 1000)); // 1 minute
const SECURITY_ACTION_TIMEOUT_MS = parseInt(process.env["SECURITY_ACTION_TIMEOUT_MS"] || String(10 * 60 * 1000)); // 10 minutes
const SECURITY_LOG_CHANNEL_ID = process.env["SECURITY_LOG_CHANNEL_ID"] || BAN_LOG_CHANNEL_ID;

const moderatorActionTimestamps = new Map<string, number[]>();

async function recordModeratorAction(guild: Guild, moderatorId: string) {
  const now = Date.now();
  const arr = moderatorActionTimestamps.get(moderatorId) ?? [];
  // keep only recent
  const filtered = arr.filter((t) => t > now - SECURITY_ACTION_WINDOW_MS);
  filtered.push(now);
  moderatorActionTimestamps.set(moderatorId, filtered);
  if (filtered.length > SECURITY_ACTION_THRESHOLD) {
    // Apply timeout to the moderator to prevent further actions
    try {
      const member = await guild.members.fetch(moderatorId).catch(() => null);
      if (member && typeof (member as any).timeout === "function") {
        await (member as any).timeout(SECURITY_ACTION_TIMEOUT_MS, "Exceeded moderator action threshold").catch(() => {});
      }
    } catch (e) { log.error("Failed to timeout moderator:", e); }

    // Notify security/mod-log channel
    try {
      const logCh = guild.channels.cache.get(SECURITY_LOG_CHANNEL_ID) ?? await client.channels.fetch(SECURITY_LOG_CHANNEL_ID).catch(() => null);
      if (logCh && "send" in logCh) {
        const embed = new EmbedBuilder()
          .setTitle("Automatic Moderator Timeout")
          .setColor("#ef4444")
          .addFields(
            { name: "Moderator", value: `<@${moderatorId}>`, inline: true },
            { name: "Reason", value: "Exceeded moderator action thresholds", inline: true },
          )
          .setTimestamp();
        await (logCh as any).send({ embeds: [embed] }).catch(() => {});
      }
      // Also log to configured timeout log channel (guild-level)
      const configured = timeoutLogChannels[guild.id];
      if (configured) {
        const ch = guild.channels.cache.get(configured) ?? await client.channels.fetch(configured).catch(() => null);
        if (ch && "send" in ch) await (ch as any).send({ embeds: [new EmbedBuilder().setTitle("Timeout applied").setDescription(`<@${moderatorId}> was timed out`).setTimestamp()] }).catch(() => {});
      }
      appendAuditLog(`MOD_TIMEOUT guild=${guild.id} moderator=${moderatorId} reason=threshold`);
    } catch (e) { log.error("Failed to send security log:", e); }

    // reset timestamps to avoid repeated timeouts
    moderatorActionTimestamps.set(moderatorId, []);
    return false;
  }
  return true;
}

// Spam protection: track recent messages per-user-per-guild
const SPAM_THRESHOLD = parseInt(process.env["SPAM_THRESHOLD"] || "5"); // messages
const SPAM_WINDOW_MS = parseInt(process.env["SPAM_WINDOW_MS"] || String(60 * 1000)); // 1 minute
const SPAM_TIMEOUT_MS = parseInt(process.env["SPAM_TIMEOUT_MS"] || String(5 * 60 * 1000)); // 5 minutes
const userMessageTimestamps = new Map<string, Map<string, number[]>>(); // guildId -> (userId -> timestamps)

// Recent leaves tracking
const recentLeaves = new Map<string, { guildId: string; guildName: string; leftAt: number }[]>();

async function recordMessageAndCheckSpam(message: Message) {
  const guildId = message.guild!.id;
  const userId = message.author.id;
  let guildMap = userMessageTimestamps.get(guildId);
  if (!guildMap) { guildMap = new Map(); userMessageTimestamps.set(guildId, guildMap); }
  const now = Date.now();
  const arr = guildMap.get(userId) ?? [];
  const recent = arr.filter((t) => t > now - SPAM_WINDOW_MS);
  recent.push(now);
  guildMap.set(userId, recent);
  if (recent.length >= SPAM_THRESHOLD) {
    // apply timeout and delete recent messages in this channel
    try {
      const member = await message.guild!.members.fetch(userId).catch(() => null);
      if (member && !(member.permissions?.has(PermissionsBitField.Flags.ManageMessages) || hasModeratorRole(member))) {
        try { await (member as any).timeout(SPAM_TIMEOUT_MS, "Automated spam protection"); } catch (e) { log.error("Failed to timeout spammer:", e); }
      }
    } catch (e) { log.error("recordMessageAndCheckSpam fetch member:", e); }

    // delete the user's recent messages in this channel (up to threshold)
    try {
      const ch = message.channel as any;
      if (ch && ch.messages && typeof ch.messages.fetch === "function") {
        const fetched = await ch.messages.fetch({ limit: 100 }).catch(() => null);
        if (fetched) {
          const userMsgs = Array.from(fetched.values()).filter((m: Message) => m.author.id === userId).slice(0, SPAM_THRESHOLD);
          if (userMsgs.length) {
            try {
              // bulkDelete only supports <14 days
              const toBulk = userMsgs.map((m: Message) => m.id);
              await ch.bulkDelete(toBulk, true).catch(async () => {
                // fallback: delete one by one
                for (const m of userMsgs) await m.delete().catch(() => {});
              });
            } catch (e) { /* ignore */ }
          }
        }
      }
    } catch (e) { log.error("Failed to delete spam messages:", e); }

    // reset timestamps for user to avoid repeated actions
    guildMap.set(userId, []);
    // send timeout log embed if configured
    try {
      const conf = timeoutLogChannels[message.guild!.id];
      const embed = new EmbedBuilder()
        .setTitle("Automated Timeout — Spam")
        .setColor("#ef4444")
        .addFields(
          { name: "User", value: `<@${userId}>`, inline: true },
          { name: "Guild", value: message.guild!.name, inline: true },
          { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
          { name: "Reason", value: `Sent ${SPAM_THRESHOLD} messages within ${Math.round(SPAM_WINDOW_MS/1000)}s`, inline: false },
        )
        .setTimestamp();
      if (conf) {
        const ch = message.guild!.channels.cache.get(conf) ?? await client.channels.fetch(conf).catch(() => null);
        if (ch && "send" in ch) await (ch as any).send({ embeds: [embed] }).catch(() => {});
      }
      appendAuditLog(`AUTO_TIMEOUT guild=${message.guild!.id} user=${userId} channel=${message.channel.id} reason=spam`);
    } catch (e) { log.error("Failed to send timeout log:", e); }
    return false;
  }
  return true;
}

function hasModeratorRole(member: GuildMember | null | undefined): boolean {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.ManageRoles)) return true;
  return member.roles.cache.some(
    (r) => r.name.toLowerCase() === MOD_ROLE_NAME.toLowerCase() || r.id === MOD_ROLE_ID,
  );
}

function hasBanSubmissionRole(member: GuildMember | null | undefined): boolean {
  if (!member) return false;
  if (hasModeratorRole(member)) return true;
  return member.roles.cache.some((r) => r.id === BAN_SUBMIT_ROLE_ID);
}

async function buildLeaderboardEmbed(guildId: string) {
  const leaderboard = banStore.getLeaderboard(guildId).slice(0, 10);
  const guild = client.guilds.cache.get(guildId);
  const serverName = guild?.name ?? "Server";
  const embed = new EmbedBuilder().setTitle("Scan Register Leaderboard").setColor("#ff0000");
  embed.setAuthor({ name: serverName, iconURL: guild?.iconURL() ?? client.user?.displayAvatarURL() ?? undefined });
  embed.setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null);
  embed.setFooter({ text: "Updating Live" });

  if (leaderboard.length === 0) {
    embed.setDescription("No scan-register logs yet.");
    return embed;
  }

    const spacer = "\u00A0\u00A0\u00A0\u00A0\u00A0"; // non-breaking spaces for consistent spacing
    const header = `🟢 Bypassed${spacer}🟠 Format${spacer}⚪ Clean${spacer}🔴 Failed\n\n`;
    const lines = leaderboard.map((e) => `<@${e.moderatorId}> — ${e.total}${spacer}🟢 ${e.bypassed}${spacer}🟠 ${e.format}${spacer}⚪ ${e.clean}${spacer}🔴 ${e.failed}`);
    embed.setDescription(header + lines.join("\n"));
  return embed;
}

async function findExistingLeaderboardMessage(guildId: string, channel: any): Promise<Message | null> {
  if (!channel || !("messages" in channel)) return null;
  const mapping = banStore.getLeaderboardMessage(guildId);
  console.log("findExistingLeaderboardMessage: mapping=", mapping);
  if (mapping && mapping.channelId === channel.id) {
    const mapped = await channel.messages.fetch(mapping.messageId).catch(() => null);
    if (mapped) return mapped;
  }

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return null;

  const existing = messages.find((m: Message) => {
    if (!m.embeds.length) return false;
    const t = m.embeds[0].title?.toString() ?? "";
    return t === "Scan Register Leaderboard" || t === "Ban Leaderboard" || t.includes("Leaderboard");
  });
  if (existing) {
    console.log("findExistingLeaderboardMessage: found existing message id=", existing.id);
    banStore.setLeaderboardMessage(guildId, channel.id, existing.id);
    return existing;
  }

  return null;
}

function resolveRole(guild: Guild, input: string) {
  const mention = input.match(/^<@&?(\d+)>$/);
  if (mention) return guild.roles.cache.get(mention[1]!) ?? null;
  if (/^\d{17,20}$/.test(input)) return guild.roles.cache.get(input) ?? null;
  return guild.roles.cache.find((r) => r.name.toLowerCase() === input.toLowerCase()) ?? null;
}

async function resolveMember(guild: Guild, input: string) {
  const mention = input.match(/^<@!?(\d+)>$/);
  if (mention) return guild.members.fetch(mention[1]!).catch(() => null);
  if (/^\d{17,20}$/.test(input)) return guild.members.fetch(input).catch(() => null);
  return null;
}

function buildApprovalEmbed(r: { userId: string; roleNames: string[]; roleIds?: string[]; nickname: string; inGameId: string }) {
  const rolesText = r.roleIds && r.roleIds.length
    ? r.roleIds.map((id) => `<@&${id}>`).join(" ")
    : formatRequestedRoles(r.roleNames);
  return new EmbedBuilder()
    .setColor("#00bfff")
    .setTitle("ScreenShare role request review")
    .setDescription("A new ScreenShare role request needs review.")
    .addFields(
      { name: "User", value: `<@${r.userId}>`, inline: true },
      { name: "Requested roles", value: rolesText, inline: false },
      { name: "Display name", value: r.nickname, inline: true },
      { name: "ID", value: r.inGameId || "—", inline: true },
    )
    .setTimestamp();
}

async function refreshGuildInvites(guild: Guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (invites) guildInviteCache.set(guild.id, invites);
  return invites;
}

async function getGuildVanityCode(guild: Guild): Promise<string | null> {
  try {
    const vanityData = await guild.fetchVanityData().catch(() => null);
    if (vanityData?.code) return vanityData.code.toLowerCase();
  } catch {}
  return guild.vanityURLCode?.toLowerCase() ?? null;
}

function findInviteUsed(before: any, after: any) {
  if (!before || !after) return null;
  for (const [code, invite] of after.entries()) {
    const previous = before.get(code);
    if (!previous) continue;
    const nextUses = invite?.uses ?? 0;
    const prevUses = previous?.uses ?? 0;
    if (nextUses > prevUses) return invite;
  }
  return null;
}

function buildRoleSelectionMenu(requestId: string, roles: Role[]) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`role-request-select:${requestId}`)
    .setPlaceholder("Select one or more roles")
    .setMinValues(1)
    .setMaxValues(Math.min(roles.length, 25))
    .addOptions(buildRoleSelectionOptions(roles));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildRequestButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("request-role")
      .setLabel("⚔️  — Request a Role —  ⚔️")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildBanButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("submit-ban")
      .setLabel("Scan Register")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildDmComposerButton(roleId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dm-compose:${roleId}`)
      .setLabel("Open DM Input")
      .setStyle(ButtonStyle.Primary),
  );
}

function cleanup(msg: Message, delay = 10000) {
  setTimeout(() => msg.delete().catch(() => {}), delay);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => log.info(`Discord bot ready: ${client.user?.tag}`));

client.on("error",          (e)      => log.error("Client error:", e));
client.on("shardError",     (e)      => log.error("Shard error:", e));
client.on("shardDisconnect",(ev, id) => log.warn(`Shard ${id} disconnected (${ev.code}) — will reconnect`));
client.on("shardReconnecting",(id)   => log.info(`Shard ${id} reconnecting...`));
client.on("shardResume",    (id)     => log.info(`Shard ${id} resumed`));

process.on("unhandledRejection", (r) => log.error("Unhandled rejection:", r));

// Periodic leaderboard updater: edit stored leaderboard messages every 5 minutes
async function updateAllLeaderboards() {
  try {
    const map = banStore.getAllLeaderboardMappings();
    for (const [guildId, info] of Object.entries(map) as [string, { channelId: string; messageId: string }][]) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const ch = guild.channels.cache.get(info.channelId);
      if (!ch || !("messages" in ch)) continue;
      const msg = await (ch as any).messages.fetch(info.messageId).catch(() => null);
      if (!msg) continue;
      const lbEmbed = await buildLeaderboardEmbed(guildId);
      await msg.edit({ embeds: [lbEmbed] }).catch(() => {});
        console.log(`Updated leaderboard for guild ${guildId}`);
    }
  } catch (e) { log.error("updateAllLeaderboards:", e); }
}

client.once("ready", async () => {
  // run at startup and then every 5 minutes
  updateAllLeaderboards().catch(() => {});
  for (const [, guild] of client.guilds.cache) {
    await refreshGuildInvites(guild).catch(() => {});
  }
  setInterval(() => updateAllLeaderboards().catch(() => {}), 5 * 60 * 1000);
});

client.on("guildCreate", async (guild) => {
  await refreshGuildInvites(guild).catch(() => {});
});

// ── Welcome ──────────────────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  try {
    const configuredCode = AUTO_GRANT_INVITE_CODE.toLowerCase();
    const vanityCode = await getGuildVanityCode(member.guild);
    const beforeInvites = guildInviteCache.get(member.guild.id);
    const afterInvites = await refreshGuildInvites(member.guild);
    const usedInvite = findInviteUsed(beforeInvites, afterInvites);
    const usedInviteCode = usedInvite?.code?.toLowerCase();
    const shouldGrant = Boolean(vanityCode && vanityCode === configuredCode) || Boolean(usedInviteCode && usedInviteCode === configuredCode);

    if (shouldGrant) {
      const rewardRole = await member.guild.roles.fetch(AUTO_GRANT_ROLE_ID).catch(() => null);
      if (rewardRole) {
        await member.roles.add(rewardRole, "Joined via configured invite");
      } else {
        log.warn(`Auto-grant role ${AUTO_GRANT_ROLE_ID} not found in guild ${member.guild.id}`);
      }
    }
  } catch (e) {
    log.error("Failed to process invite-based auto-role:", e);
  }

  const channel = member.guild.channels.cache.get(WELCOME_CH);
  if (!channel?.isTextBased()) {
    log.warn(`Welcome channel ${WELCOME_CH} not available for guild ${member.guild.id}`);
    return;
  }

  const n = member.guild.memberCount;
  const embed = new EmbedBuilder()
    .setColor("#22c55e")
    .setTitle(`Welcome to ${member.guild.name}!`)
    .setDescription(`Hey ${member.toString()}, welcome to **${member.guild.name}**!\nYou are the **${n}th** member!`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `Member #${n}` })
    .setTimestamp();
  await channel.send({
    content: `Welcome ${member.toString()} to **${member.guild.name}**! You are the **${n}th** member!`,
    embeds: [embed],
  }).catch((e) => log.error("Failed to send welcome:", e));
});

// ── Interactions ─────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction): Promise<void> => {
  if (!interaction.guild) return;

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("dm-compose:")) {
      if (!hasModeratorRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can send DMs.", ephemeral: true });
        return;
      }
      const roleId = interaction.customId.split(":")[1]!;
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) {
        await interaction.reply({ content: "That role is no longer available.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder().setCustomId(`dm-submit:${role.id}`).setTitle(`Send DM To • ${role.name}`);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("dmTitle").setLabel("Subject / Heading").setStyle(TextInputStyle.Short).setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("dmMessage").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === "open-embed-modal") {
      if (!hasModeratorRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can create embeds.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder().setCustomId("embed-submit").setTitle("Create Embed Message");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("embedChannel")
            .setLabel("Channel mention or ID")
            .setStyle(TextInputStyle.Short)
            .setValue(interaction.channel ? `<#${interaction.channel.id}>` : "")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("embedTitle").setLabel("Embed Title").setStyle(TextInputStyle.Short).setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("embedDescription").setLabel("Embed Description").setStyle(TextInputStyle.Paragraph).setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("embedColor").setLabel("Embed Color (#hex)").setStyle(TextInputStyle.Short).setRequired(false),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    // Ban log button
    if (interaction.customId === "submit-ban") {
      if (!hasBanSubmissionRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can submit bans.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder().setCustomId("ban-submit").setTitle("Scan Register");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("bannedId").setLabel("User ID").setStyle(TextInputStyle.Short).setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    // Scan status button (from modal follow-up)
    if (interaction.customId.startsWith("scan-status:")) {
      if (!hasBanSubmissionRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can submit logs.", ephemeral: true });
        return;
      }
      const parts = interaction.customId.split(":");
      const status = parts[1] as "failed" | "bypassed" | "format" | "clean";
      const pendingId = parts[2];
      const pending = pendingScanLogs.get(pendingId);
      if (!pending) {
        await interaction.reply({ content: "This log session has expired or is invalid.", ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 30000);
        return;
      }
      // Acknowledge the interaction quickly to avoid "interaction failed" due to long processing
      try { await interaction.deferReply({ ephemeral: true }); } catch {}
      try {
        banStore.addBan(pending.moderatorId, pending.targetId, status, pending.guildId);
      } catch (e) { log.error("banStore.addBan:", e); }

      const embed = new EmbedBuilder()
        .setColor(
          status === "bypassed" ? "#22c55e"
            : status === "failed" ? "#ef4444"
              : status === "format" ? "#f97316"
                : "#d1d5db",
        )
        .setTitle("Scan Register Log")
        .addFields(
          { name: "Moderator", value: `<@${pending.moderatorId}>`, inline: true },
          { name: "Target ID", value: pending.targetId, inline: true },
          { name: "Status", value: status, inline: true },
        )
        .setTimestamp();

      if (BAN_LOG_CHANNEL_ID) {
        const logChannel = interaction.guild!.channels.cache.get(BAN_LOG_CHANNEL_ID)
          ?? await client.channels.fetch(BAN_LOG_CHANNEL_ID).catch(() => null);
        if (logChannel && "send" in logChannel) {
          try { await (logChannel as any).send({ embeds: [embed] }); } catch (e) { log.error("Failed to send ban log message:", e); }
        }
      }

      try {
        const dedicatedLogChannel = await client.channels.fetch(DEDICATED_BAN_LOG_CHANNEL_ID).catch(() => null);
        if (dedicatedLogChannel && "send" in dedicatedLogChannel) {
          await (dedicatedLogChannel as any).send({ embeds: [embed] });
        }
      } catch (e) { log.error("Failed to send to dedicated ban log channel:", e); }

      // Update leaderboard: prefer saved mapping, otherwise fall back to configured channel
      try {
        const lbEmbed = await buildLeaderboardEmbed(interaction.guild!.id);
        const mapping = banStore.getLeaderboardMessage(interaction.guild!.id);
        if (mapping) {
          // Try to fetch channel/message directly
          const mappedCh = interaction.guild!.channels.cache.get(mapping.channelId) ?? await client.channels.fetch(mapping.channelId).catch(() => null);
          if (mappedCh && "messages" in mappedCh) {
            const mappedMsg = await (mappedCh as any).messages.fetch(mapping.messageId).catch(() => null);
            if (mappedMsg) {
              await mappedMsg.edit({ embeds: [lbEmbed] });
            } else {
              // Could not fetch stored message; try to find in that channel or send new
              const found = await findExistingLeaderboardMessage(interaction.guild!.id, mappedCh as any);
              if (found) await found.edit({ embeds: [lbEmbed] });
              else { const sent = await (mappedCh as any).send({ embeds: [lbEmbed] }); banStore.setLeaderboardMessage(interaction.guild!.id, (mappedCh as any).id, sent.id); }
            }
            // done
          } else if (BAN_LEADERBOARD_CHANNEL_ID) {
            const lbCh = interaction.guild!.channels.cache.get(BAN_LEADERBOARD_CHANNEL_ID);
            const existing = lbCh ? await findExistingLeaderboardMessage(interaction.guild!.id, lbCh as any) : null;
            if (existing) await existing.edit({ embeds: [lbEmbed] });
            else if (lbCh && "send" in lbCh) { const sent = await (lbCh as any).send({ embeds: [lbEmbed] }); banStore.setLeaderboardMessage(interaction.guild!.id, (lbCh as any).id, sent.id); }
          }
        } else if (BAN_LEADERBOARD_CHANNEL_ID) {
          const lbCh = interaction.guild!.channels.cache.get(BAN_LEADERBOARD_CHANNEL_ID);
          if (lbCh && "send" in lbCh) {
            const existing = await findExistingLeaderboardMessage(interaction.guild!.id, lbCh as any);
            if (existing) { await existing.edit({ embeds: [lbEmbed] }); banStore.setLeaderboardMessage(interaction.guild!.id, (lbCh as any).id, existing.id); }
            else { const sent = await (lbCh as any).send({ embeds: [lbEmbed] }); banStore.setLeaderboardMessage(interaction.guild!.id, (lbCh as any).id, sent.id); }
          }
        }
      } catch (e) { log.error("Failed to update leaderboard:", e); }

      pendingScanLogs.delete(pendingId);
      try {
        await interaction.editReply({ content: `Logged ${pending.targetId} as **${status}**.` });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
      } catch (e) { /* ignore reply errors */ }
      return;
    }
    // Request Role button - show role selection first
    if (interaction.customId === "request-role") {
      const roles = REQUESTABLE_ROLE_IDS
        .map((id) => interaction.guild!.roles.cache.get(id))
        .filter((r): r is Role => !!r)
        .sort((a, b) => b.position - a.position);
      if (!roles.length) {
        await interaction.reply({ content: "No selectable roles are available.", ephemeral: true });
        return;
      }

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingRoleMetadata.set(requestId, {
        userId: interaction.user.id,
        nickname: "",
        inGameId: "",
        guildId: interaction.guild!.id,
      });

      const selectEmbed = new EmbedBuilder()
        .setColor("#00bfff")
        .setTitle("Select Roles")
        .setDescription("Choose the role's you want to request. Then click off the dropdown. You will then be prompted to fill in your details.");

      await interaction.reply({
        embeds: [selectEmbed],
        components: [buildRoleSelectionMenu(requestId, roles)],
        ephemeral: true,
      });
      return;
    }

    // Approve / Decline
    if (interaction.customId.startsWith("role-approve:") || interaction.customId.startsWith("role-decline:")) {
      if (!hasModeratorRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can approve or decline role requests.", ephemeral: true });
        return;
      }
      const requestId = interaction.customId.split(":")[1]!;
      let request = pendingRequests.get(requestId);

      // If in-memory request missing (e.g., bot restarted), try to reconstruct from the message embed
      if (!request) {
        const msg = interaction.message as Message;
        const embed = msg?.embeds?.[0];
        if (embed) {
          const fields = embed.fields ?? [];
          const userField = fields.find((f) => f.name === "User");
          const rolesField = fields.find((f) => f.name === "Requested roles");
          const nickField = fields.find((f) => f.name === "Display name");
          const idField = fields.find((f) => f.name === "ID");
          const userIdMatch = userField?.value?.match(/^<@!?(\d+)>$/);
          const userId = userIdMatch ? userIdMatch[1] : userField?.value?.replace(/[^0-9]/g, "") ?? null;
          const roleNames = rolesField ? rolesField.value.split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [];
          const nickname = nickField?.value ?? "";
          const inGameId = idField?.value && idField.value !== "—" ? idField.value : "";
          if (userId) {
            request = { userId, roleIds: [], roleNames, nickname, inGameId, approvalChannelId: (interaction.channel as any).id };
            // store reconstructed request under the message id so future clicks within this runtime work
            pendingRequests.set(requestId, request);
            savePendingRequestsToDisk();
          }
        }
      }

      if (!request) {
        await interaction.reply({ content: "That request is no longer available.", ephemeral: true });
        return;
      }

      const targetMember = await resolveMember(interaction.guild!, request.userId);
      // Resolve roles by name when we don't have IDs
      const requestedRoles = request.roleIds.length
        ? request.roleIds.map((id) => resolveRole(interaction.guild!, id)).filter((r): r is Role => !!r)
        : request.roleNames.map((name) => interaction.guild!.roles.cache.find((r) => r.name === name)).filter((r): r is Role => !!r);

      if (!targetMember || !requestedRoles.length) {
        pendingRequests.delete(requestId);
        savePendingRequestsToDisk();
        await interaction.reply({ content: "Member or role no longer available.", ephemeral: true });
        return;
      }

      // Check moderator action rate-limit before performing role changes
      const modId = (interaction.member as GuildMember).id;
      try {
        const allowed = await recordModeratorAction(interaction.guild!, modId);
        if (!allowed) {
          await interaction.reply({ content: "You have exceeded the allowed number of moderation actions and have been temporarily timed out for security reasons.", ephemeral: true });
          return;
        }
      } catch (e) { log.error("recordModeratorAction:", e); }

      // Defer update immediately so we have time to perform role changes and edits
      try { await interaction.deferUpdate(); } catch {}

      if (interaction.customId.startsWith("role-approve:")) {
        try {
          const verificationRole = interaction.guild.roles.cache.get(AUTO_GRANT_ROLE_ID);
          if (verificationRole) await targetMember.roles.remove(verificationRole, "Removed after role request approved");
          await targetMember.roles.add(requestedRoles, "Approved via button");
        } catch {
          await interaction.reply({ content: "Could not update the member's roles.", ephemeral: true }); return;
        }
        const nick = request.inGameId
          ? `SM |👻 ${request.nickname} | ${request.inGameId}`
          : `SM |👻 ${request.nickname}`;
        await targetMember.setNickname(nick).catch(() => {});
        await targetMember.send(`Your role request for ${request.roleNames.join(", ")} was approved. Nickname: ${nick}`).catch(() => {});
        pendingRequests.delete(requestId);
        savePendingRequestsToDisk();

        // Edit the original embed to show approval and who approved it
        const approvedEmbed = buildApprovalEmbed({ userId: request.userId, roleNames: request.roleNames, roleIds: request.roleIds, nickname: request.nickname, inGameId: request.inGameId })
          .setColor("#22c55e")
          .setTitle("Role request approved")
          .addFields({ name: "Approved by", value: `<@${(interaction.member as GuildMember).id}>`, inline: true });

        // Edit the original approval message (interaction.update may have timed out)
        try {
          const msg = interaction.message as Message;
          await msg.edit({ embeds: [approvedEmbed.setTimestamp()], components: [] });
        } catch (e) { log.error("Failed to edit approval message:", e); }
        return;
      }

      await targetMember.send(`Your role request for ${request.roleNames.join(", ")} was declined.`).catch(() => {});
      pendingRequests.delete(requestId);
      savePendingRequestsToDisk();
      const declinedEmbed = buildApprovalEmbed({ userId: request.userId, roleNames: request.roleNames, roleIds: request.roleIds, nickname: request.nickname, inGameId: request.inGameId })
        .setColor("#ef4444")
        .setTitle("Role request declined")
        .addFields({ name: "Declined by", value: `<@${(interaction.member as GuildMember).id}>`, inline: true });
      try {
        const msg = interaction.message as Message;
        await msg.edit({ embeds: [declinedEmbed.setTimestamp()], components: [] });
      } catch (e) { log.error("Failed to edit declined message:", e); }
    }
  }

  // Modal submit
  if (interaction.isModalSubmit() && interaction.customId === "embed-submit") {
    if (!hasModeratorRole(interaction.member as GuildMember)) { await interaction.reply({ content: "Only moderators can create embeds.", ephemeral: true }); return; }
    const channelInput = interaction.fields.getTextInputValue("embedChannel").trim();
    const title = interaction.fields.getTextInputValue("embedTitle").trim();
    const description = interaction.fields.getTextInputValue("embedDescription").trim();
    const colorInput = interaction.fields.getTextInputValue("embedColor").trim();

    const channelId = channelInput.replace(/[<#>]/g, "");
    const targetChannel = interaction.guild?.channels.cache.get(channelId)
      ?? interaction.guild?.channels.cache.find((ch) => ch.name === channelInput.replace(/^#/, ""));
    if (!targetChannel || !("send" in targetChannel)) {
      await interaction.reply({ content: "Could not find that text channel.", ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder();
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    if (colorInput) {
      try { embed.setColor(colorInput as any); } catch {}
    }
    embed.setTimestamp();

    try {
      await (targetChannel as any).send({ embeds: [embed] });
      await interaction.reply({ content: `✅ Embed sent to <#${(targetChannel as any).id}>`, ephemeral: true });
    } catch (e) {
      log.error("Failed to send embed message:", e);
      await interaction.reply({ content: "Could not send embed to that channel.", ephemeral: true });
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("dm-submit:")) {
    if (!hasModeratorRole(interaction.member as GuildMember)) { await interaction.reply({ content: "Only moderators can send DMs.", ephemeral: true }); return; }
    const roleId = interaction.customId.split(":")[1]!;
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) { await interaction.reply({ content: "That role is no longer available.", ephemeral: true }); return; }

    const titleInput = interaction.fields.getTextInputValue("dmTitle").trim();
    const messageText = interaction.fields.getTextInputValue("dmMessage").replace(/\r\n/g, "\n");
    if (!messageText.trim()) { await interaction.reply({ content: "You must enter a message.", ephemeral: true }); return; }

    await interaction.deferReply({ ephemeral: true });
    await interaction.guild.members.fetch();
    const members = interaction.guild.members.cache.filter((m) => m.roles.cache.has(role.id) && !m.user.bot);
    const embed = new EmbedBuilder()
      .setColor("#2563eb")
      .setTitle(titleInput || "ScreenShare")
      .setDescription(messageText)
      .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
      .setFooter({ text: `${interaction.guild.name} • Sent by ${interaction.user.username}` })
      .setTimestamp();

    let sent = 0, failed = 0;
    for (const [, member] of members) {
      try { await member.send({ embeds: [embed] }); sent++; } catch { failed++; }
    }

    await interaction.editReply({ content: `✅ DM sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.` });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "ban-submit") {
    if (!hasBanSubmissionRole(interaction.member as GuildMember)) { await interaction.reply({ content: "Only moderators can submit ban logs.", ephemeral: true }); return; }
    const bannedId = interaction.fields.getTextInputValue("bannedId").trim();
    if (!bannedId) { await interaction.reply({ content: "You must enter the user's ID.", ephemeral: true }); return; }
    const moderatorId = (interaction.member as GuildMember).id;

    const pendingId = `scan_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    pendingScanLogs.set(pendingId, { moderatorId, targetId: bannedId, guildId: interaction.guild.id });

    // Ask moderator to choose status
    await interaction.reply({
      content: `Choose scan-register status for **${bannedId}**:`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`scan-status:bypassed:${pendingId}`).setLabel("🟢 Bypassed").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`scan-status:format:${pendingId}`).setLabel("🟠 Format").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`scan-status:clean:${pendingId}`).setLabel("⚪ Clean").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`scan-status:failed:${pendingId}`).setLabel("🔴 Failed").setStyle(ButtonStyle.Danger),
        ),
      ],
      ephemeral: true,
    });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 30000);
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("role-request-select:")) {
    if (!interaction.guild) return;
    const requestId = interaction.customId.split(":")[1]!;
    const metadata = pendingRoleMetadata.get(requestId);
    if (!metadata) {
      await interaction.reply({ content: "That request has expired. Please try again.", ephemeral: true });
      return;
    }

    const selectedRoleIds = interaction.values;
    const requestedRoles = selectedRoleIds
      .map((id) => interaction.guild!.roles.cache.get(id))
      .filter((r): r is Role => !!r)
      .filter((role) => REQUESTABLE_ROLE_IDS.includes(role.id));

    if (!requestedRoles.length) {
      await interaction.reply({ content: "Please select at least one role.", ephemeral: true });
      return;
    }

    // Store selected role IDs and names in metadata
    const storedRequestId = `finalize-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingRoleMetadata.set(storedRequestId, {
      ...metadata,
      nickname: selectedRoleIds.join("|"), // Store as pipe-separated for now
    });

    // Show the name/ID modal
    const modal = new ModalBuilder().setCustomId(`role-request-final:${storedRequestId}`).setTitle("Complete Your Request");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("requestedName").setLabel("Your Name").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("requestedDiscordId").setLabel("Your ID").setStyle(TextInputStyle.Short).setRequired(false),
      ),
    );

    await interaction.showModal(modal);
  }

  // Commands dropdown handler (bot commands list)
  if (interaction.isStringSelectMenu() && interaction.customId === "bot-commands-select") {
    const choice = interaction.values[0];
    let content = "";
    if (choice === "role-request") content = "Click the role request button to start a role request flow (then fill name/ID and select roles).";
    else if (choice === "scan-register") content = "Use the Scan Register button to log scan-register results and update the leaderboard.";
    else if (choice === "setup-buttons") content = "Moderator commands: `!setuprolebutton` and `!setupbanbutton` to install interactive buttons in a channel.";
    else if (choice === "profile") content = "Shows a brief bot profile and stats.";
    else content = "Unknown command.";

    await interaction.reply({ content, ephemeral: true });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("role-request-final:")) {
    if (!interaction.guild) return;
    const storedRequestId = interaction.customId.split(":")[1]!;
    const metadata = pendingRoleMetadata.get(storedRequestId);
    if (!metadata) {
      await interaction.reply({ content: "That request has expired. Please try again.", ephemeral: true });
      return;
    }

    const name = interaction.fields.getTextInputValue("requestedName").trim();
    const inGameId = interaction.fields.getTextInputValue("requestedDiscordId").trim();
    if (!name) { await interaction.reply({ content: "You must enter a name.", ephemeral: true }); return; }

    // Reconstruct the selected roles from stored IDs
    const selectedRoleIds = metadata.nickname.split("|");
    const requestedRoles = selectedRoleIds
      .map((id) => interaction.guild!.roles.cache.get(id))
      .filter((r): r is Role => !!r)
      .sort((a, b) => b.position - a.position);

    if (!requestedRoles.length) {
      await interaction.reply({ content: "Role selection expired. Please try again.", ephemeral: true });
      return;
    }

    const targetMember = interaction.member as GuildMember;
    const approvalChannel = APPROVAL_CH
      ? interaction.guild.channels.cache.get(APPROVAL_CH)
      : interaction.channel;

    if (!approvalChannel || !("send" in approvalChannel)) {
      await interaction.reply({ content: "Approval channel not configured.", ephemeral: true }); return;
    }

    const ch = approvalChannel as { send: Function; id: string };
    const approvalMsg = await ch.send({
      embeds: [buildApprovalEmbed({ userId: targetMember.id, roleNames: requestedRoles.map((role) => role.name), roleIds: requestedRoles.map((role) => role.id), nickname: name, inGameId })],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("role-approve:pending").setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("role-decline:pending").setLabel("Decline").setStyle(ButtonStyle.Danger),
      )],
    });

    await approvalMsg.edit({
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`role-approve:${approvalMsg.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`role-decline:${approvalMsg.id}`).setLabel("Decline").setStyle(ButtonStyle.Danger),
      )],
    });

    pendingRequests.set(approvalMsg.id, {
      userId: targetMember.id,
      roleIds: requestedRoles.map((role) => role.id),
      roleNames: requestedRoles.map((role) => role.name),
      nickname: name,
      inGameId,
      approvalChannelId: ch.id,
    });
    savePendingRequestsToDisk();
    pendingRoleMetadata.delete(storedRequestId);
    await interaction.reply({ content: "Your request has been sent to moderators for review.", ephemeral: true });
  }
});

// ── Message commands ──────────────────────────────────────────────────────────
client.on("guildMemberRemove", async (member) => {
  try {
    const arr = recentLeaves.get(member.id) ?? [];
    arr.unshift({ guildId: member.guild.id, guildName: member.guild.name, leftAt: Date.now() });
    // keep last 20
    recentLeaves.set(member.id, arr.slice(0, 20));
  } catch (e) { log.error("guildMemberRemove tracking failed:", e); }
});

client.on("messageCreate", async (message): Promise<void> => {
  if (!message.guild || message.author.bot) return;

  // Spam protection (non-mods/bots)
  try {
    if (!(message.member && hasModeratorRole(message.member))) {
      const ok = await recordMessageAndCheckSpam(message);
      if (!ok) {
        // user was timed out; inform moderators briefly
        const info = await message.channel.send({ content: `<@${message.author.id}> has been temporarily timed out for spamming.` }).catch(() => null);
        if (info) setTimeout(() => info.delete().catch(() => {}), 5000);
        return;
      }
    }
  } catch (e) { log.error("Spam check failed:", e); }

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  // !setuprolebutton
  if (command === "setuprolebutton") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#8a8b8b")
          .setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL() ?? undefined })
          .setTitle("👻  Role Request")
          .setDescription("\u200b\nThe Bot will automatically Update your name To the correct format when approved.\n\u200b")
          .addFields({ name: "📋  How it works", value: "1. Click the button below\n2. Enter your name and ID\n3. Select one or more roles from the dropdown\n4. Wait for approval" })
          .setThumbnail(message.guild.iconURL())
          .setFooter({ text: `${message.guild.name} • Role System` })
          .setTimestamp(),
      ],
      components: [buildRequestButton()],
    });
    return;
  }

  // !setupbanbutton
  if (command === "setupbanbutton") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ff0000")
          .setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL() ?? undefined })
          .setTitle("Scan Register")
          .setDescription("Log a Scan-Register Result: Enter ID, then choose 'Bypassed', 'Format', 'Clean', or 'Failed'.")
          .setThumbnail(message.guild.iconURL())
          .setFooter({ text: `${message.guild.name} • Moderation Logs` })
          .setTimestamp(),
      ],
      components: [buildBanButton()],
    });
    return;
  }

  // !banlogs [@moderator|id]
  if (command === "banlogs") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const targetArg = args[0];
    let moderatorId = message.author.id;
    if (targetArg) {
      const mention = targetArg.match(/^<@!?(\d+)>$/);
      if (mention) moderatorId = mention[1]!;
      else if (/^\d{17,20}$/.test(targetArg)) moderatorId = targetArg;
    }
    const bans = banStore.getBansByModerator(moderatorId, message.guild.id);
    const user = await client.users.fetch(moderatorId).catch(() => null);
    const embed = new EmbedBuilder().setTitle(`Ban logs for ${user ? user.tag : moderatorId}`).setColor("#ef4444");
    if (!bans.length) embed.setDescription("No bans recorded for that moderator.");
    else {
      embed.addFields({ name: "Total", value: String(bans.length), inline: true });
      const lines = bans.slice(-25).map((b) => `• ${b.targetId} — ${b.status} — ${new Date(b.timestamp).toLocaleString()}`);
      embed.addFields({ name: "Recent scans", value: lines.join("\n") });
    }
    const r = await message.channel.send({ embeds: [embed] });
    cleanup(r, 30000);
    return;
  }

  // !banleaderboard
  if (command === "banleaderboard") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const embed = await buildLeaderboardEmbed(message.guild.id);
    if (BAN_LEADERBOARD_CHANNEL_ID) {
      const lbCh = message.guild.channels.cache.get(BAN_LEADERBOARD_CHANNEL_ID);
      if (lbCh && "send" in lbCh) {
        try {
          console.log("Posting leaderboard command for guild", message.guild.id);
          const existing = await findExistingLeaderboardMessage(message.guild.id, lbCh as any);
          if (existing) {
            console.log("Editing existing leaderboard message", existing.id);
            await existing.edit({ embeds: [embed] });
            banStore.setLeaderboardMessage(message.guild.id, (lbCh as any).id, existing.id);
          } else {
            console.log("Sending new leaderboard message to channel", (lbCh as any).id);
            const sent = await (lbCh as any).send({ embeds: [embed] });
            banStore.setLeaderboardMessage(message.guild.id, (lbCh as any).id, sent.id);
          }
        } catch (e) { log.error("Failed to send/edit leaderboard:", e); }
        const info = await message.channel.send(`Leaderboard posted to <#${BAN_LEADERBOARD_CHANNEL_ID}>`);
        cleanup(info, 10000);
      } else {
        await message.channel.send({ embeds: [embed] });
      }
    } else {
      await message.channel.send({ embeds: [embed] });
    }
    return;
  }

  // !bot - show bot profile and commands dropdown
  if (command === "bot" || command === "help") {
    const embed = createBotProfileEmbed(client as any);
    const menu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("bot-commands-select")
        .setPlaceholder("Select a command to learn more")
        .addOptions([
          { label: "Role Request", value: "role-request", description: "How to request roles" },
          { label: "Scan Register", value: "scan-register", description: "Log scan-register results" },
          { label: "Setup Buttons", value: "setup-buttons", description: "Install role/ban buttons" },
          { label: "Bot Profile", value: "profile", description: "Show bot info" },
        ]),
    );

    await message.channel.send({ embeds: [embed], components: [menu] });
    return;
  }

  // !addcargo @role userId
  if (command === "addcargo") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const [roleArg, userArg] = args;
    if (!roleArg || !userArg) { const r = await message.reply(`Usage: ${PREFIX}addcargo @role userId`); cleanup(r); return; }
    const role = resolveRole(message.guild, roleArg);
    const target = await resolveMember(message.guild, userArg);
    if (!role) { const r = await message.reply("Could not find that role."); cleanup(r); return; }
    if (!target) { const r = await message.reply("Could not find that user."); cleanup(r); return; }
    message.delete().catch(() => {});
    try {
      await target.roles.add(role, "Assigned by moderator command");
      const now = new Date();
      const embed = new EmbedBuilder()
        .setColor("#22c55e").setTitle("✅ Role added")
        .addFields(
          { name: "Server", value: message.guild.name, inline: true },
          { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
          { name: "Date and time", value: `${now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`, inline: true },
          { name: "Role", value: `${role.name}\n${role.id}`, inline: true },
          { name: "Executed by", value: `${message.author.username}\n${message.member?.toString()}\n${message.author.id}`, inline: true },
          { name: "\u200b", value: "\u200b", inline: true },
          { name: "Successfully added", value: `${target.toString()} ${target.user.username}\n( ${target.id} )` },
        )
        .setThumbnail(message.guild.iconURL()).setTimestamp();
      const r = await message.channel.send({ embeds: [embed] });
      cleanup(r, 10000);
    } catch (e) { log.error("addcargo:", e); const r = await message.channel.send("Could not assign that role."); cleanup(r); }
    return;
  }

  // !checkuser command removed — use OAuth2 opt-in or server-reporting network for cross-server membership data.

  // !timeoutlog <#channel|channelId|off> - configure where timeout events are logged
  if (command === "timeoutlog") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const arg = args[0];
    if (!arg) {
      const current = timeoutLogChannels[message.guild.id];
      const text = current ? `Current timeout log channel: <#${current}>` : "No timeout log channel configured.";
      const r = await message.channel.send(text); cleanup(r, 10000); return;
    }
    if (arg.toLowerCase() === "off") {
      delete timeoutLogChannels[message.guild.id];
      saveTimeoutLogChannels(timeoutLogChannels);
      const r = await message.channel.send("Timeout logging disabled for this server."); cleanup(r, 5000); return;
    }
    const channelId = arg.replace(/[<#>]/g, "");
    const targetCh = message.guild.channels.cache.get(channelId) ?? await client.channels.fetch(channelId).catch(() => null);
    if (!targetCh || !("send" in targetCh)) { const r = await message.channel.send("Could not find that text channel in this server."); cleanup(r); return; }
    timeoutLogChannels[message.guild.id] = (targetCh as any).id;
    saveTimeoutLogChannels(timeoutLogChannels);
    const r = await message.channel.send(`Timeout log channel set to <#${(targetCh as any).id}>`);
    cleanup(r, 10000);
    return;
  }

  // !remcargo @role userId
  if (command === "remcargo") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const [roleArg, userArg] = args;
    if (!roleArg || !userArg) { const r = await message.reply(`Usage: ${PREFIX}remcargo @role userId`); cleanup(r); return; }
    const role = resolveRole(message.guild, roleArg);
    const target = await resolveMember(message.guild, userArg);
    if (!role) { const r = await message.reply("Could not find that role."); cleanup(r); return; }
    if (!target) { const r = await message.reply("Could not find that user."); cleanup(r); return; }
    try {
      await message.delete().catch(() => {});
      await target.roles.remove(role, "Removed by moderator command");
      const now = new Date();
      const embed = new EmbedBuilder()
        .setColor("#ef4444").setTitle("🗑️ Role removed")
        .addFields(
          { name: "Server", value: message.guild.name, inline: true },
          { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
          { name: "Date and time", value: `${now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`, inline: true },
          { name: "Role", value: `${role.name}\n${role.id}`, inline: true },
          { name: "Executed by", value: `${message.author.username}\n${message.member?.toString()}\n${message.author.id}`, inline: true },
          { name: "\u200b", value: "\u200b", inline: true },
          { name: "Successfully removed", value: `${target.toString()} ${target.user.username}\n( ${target.id} )` },
        )
        .setThumbnail(message.guild.iconURL()).setTimestamp();
      const r = await message.channel.send({ embeds: [embed] });
      cleanup(r, 10000);
    } catch (e) { log.error("remcargo:", e); const r = await message.channel.send("Could not remove that role."); cleanup(r); }
    return;
  }

  // !embed <#channel|channelId> Title | Description | [color]
  if (command === "embed") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const prompt = await message.channel.send({
      content: "Click the button below to open the embed creation form.",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("open-embed-modal").setLabel("Create Embed").setStyle(ButtonStyle.Primary),
      )],
    });
    cleanup(prompt, 30000);
    return;
  }

  // !dm @role [message]
  if (command === "dm") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const [roleArg, ...messageParts] = args;
    const dmText = messageParts.join(" ").trim();
    if (!roleArg) { const r = await message.reply(`Usage: ${PREFIX}dm @role [message]`); cleanup(r); return; }
    const role = resolveRole(message.guild, roleArg);
    if (!role) { const r = await message.reply("Could not find that role."); cleanup(r); return; }
    await message.delete().catch(() => {});

    if (dmText) {
      await message.guild.members.fetch();
      const members = message.guild.members.cache.filter((m) => m.roles.cache.has(role.id) && !m.user.bot);
      const embed = new EmbedBuilder()
        .setColor("#2563eb")
        .setTitle("ScreenShare")
        .setDescription(dmText)
        .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
        .setFooter({ text: `${message.guild.name} • Sent by ${message.author.username}` })
        .setTimestamp();
      let sent = 0, failed = 0;
      for (const [, m] of members) {
        try { await m.send({ embeds: [embed] }); sent++; } catch { failed++; }
      }
      const r = await message.channel.send(`✅ Embed DM sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.`);
      cleanup(r, 10000);
      return;
    }

    const r = await message.channel.send({
      content: `Press the button below to send a DM to **${role.name}**.`,
      components: [buildDmComposerButton(role.id)],
    });
    cleanup(r, 15000);
    return;
  }

  // !rpbreak
  if (command === "rpbreak") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    const SSRole = message.guild.roles.cache.find((r) => r.name.toLowerCase().includes("screenshare") || r.name.toLowerCase() === "SS");
    if (!SSRole) { const r = await message.channel.send("Could not find the ScreenShare role."); cleanup(r); return; }
    await message.guild.members.fetch();
    const members = message.guild.members.cache.filter((m) => m.roles.cache.has(SSRole.id) && !m.user.bot);
    const attachment = new AttachmentBuilder(path.join(process.cwd(), "assets", "rpbreak.png"), { name: "rpbreak.png" });
    const embed = new EmbedBuilder()
      .setColor("#1e40af").setTitle("🚫  RP Break Notice")
      .setDescription("You are now placed on an **RP Break**.\n\nIf seen in RP during this time you will be **removed from the ScreenShare team**.")
      .setImage("attachment://rpbreak.png")
      .setFooter({ text: `${message.guild.name} • Issued by ${message.author.username}` }).setTimestamp();
    let sent = 0, failed = 0;
    for (const [, m] of members) {
      try { await m.send({ embeds: [embed], files: [attachment] }); sent++; } catch { failed++; }
    }
    const r = await message.channel.send(`✅ RP Break notice sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.`);
    cleanup(r, 10000);
    return;
  }

  // !rpbreakend
  if (command === "rpbreakend") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    const SSRole = message.guild.roles.cache.find((r) => r.name.toLowerCase().includes("screenshare") || r.name.toLowerCase() === "SS");
    if (!SSRole) { const r = await message.channel.send("Could not find the ScreenShare role."); cleanup(r); return; }
    await message.guild.members.fetch();
    const members = message.guild.members.cache.filter((m) => m.roles.cache.has(SSRole.id) && !m.user.bot);
    const attachment = new AttachmentBuilder(path.join(process.cwd(), "assets", "rpbreakend.png"), { name: "rpbreakend.png" });
    const embed = new EmbedBuilder()
      .setColor("#22c55e").setTitle("✅  RP Break Lifted")
      .setDescription("The RP Break has been **lifted**.\n\nYou can now return back to RP — make sure to follow server rules.")
      .setImage("attachment://rpbreakend.png")
      .setFooter({ text: `${message.guild.name} • Issued by ${message.author.username}` }).setTimestamp();
    let sent = 0, failed = 0;
    for (const [, m] of members) {
      try { await m.send({ embeds: [embed], files: [attachment] }); sent++; } catch { failed++; }
    }
    const r = await message.channel.send(`✅ RP Break end sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.`);
    cleanup(r, 10000);
    return;
  }
});

client.login(TOKEN).catch((e) => { log.error("Login failed:", e); process.exit(1); });
