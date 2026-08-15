import { EmbedBuilder, Client } from "discord.js";

export function createStandardEmbed() {
  return new EmbedBuilder()
    .setColor("#3b82f6")
    .setFooter({ text: `Powered by ScreenShare Bot` })
    .setTimestamp();
}

export function createBotProfileEmbed(client: Client) {
  const servers = client.guilds.cache.size;
  const users = client.users.cache.size;
  const embed = createStandardEmbed()
    .setTitle("ScreenShare Bot")
    .setDescription("A moderation helper for ScreenShare — role requests, scan-register, and more.")
    .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
    .addFields(
      { name: "Servers", value: String(servers), inline: true },
      { name: "Known users (cached)", value: String(users), inline: true },
      { name: "Prefix", value: "! (message commands)", inline: true },
    );
  return embed;
}

export function createHelpEmbed() {
  return createStandardEmbed()
    .setTitle("Bot Help & Commands")
    .setDescription("Below is the current command list for this bot. Use the prefix `!` before each command.")
    .addFields(
      { name: "!help", value: "Shows this help menu.", inline: false },
      { name: "!bot", value: "Shows bot profile and command shortcuts.", inline: false },
      { name: "!setuprolebutton", value: "Creates the role request system button in a channel. (Moderator only)", inline: false },
      { name: "!setupbanbutton", value: "Creates the scan-register button in a channel. (Moderator only)", inline: false },
      { name: "!welcome [#channel]", value: "Sets the welcome channel for this server. (Moderator only)", inline: false },
      { name: "!roleacceptchannel [#channel]", value: "Sets the role-approval channel for this server. (Moderator only)", inline: false },
      { name: "!botperms [@role ...|off]", value: "Shows current bot command access or sets which roles can use admin commands for this server. (Server admin only)", inline: false },
      { name: "!banlogs [@moderator|id]", value: "Shows ban/scan log activity for a moderator. (Moderator only)", inline: false },
      { name: "!banleaderboard", value: "Posts or refreshes the leaderboard. (Moderator only)", inline: false },
      { name: "!timeoutlog [#channel|off]", value: "Sets the timeout log channel. (Moderator only)", inline: false },
      { name: "!dm @role [message]", value: "Sends a DM embed to everyone in a role. (Moderator only)", inline: false },
      { name: "!embed", value: "Opens the embed creator modal. (Moderator only)", inline: false },
      { name: "!addcargo @role userId", value: "Adds a role to a user. (Moderator only)", inline: false },
      { name: "!remcargo @role userId", value: "Removes a role from a user. (Moderator only)", inline: false },
      { name: "!rpbreak", value: "Sends the RP break notice to the ScreenShare role. (Moderator only)", inline: false },
      { name: "!rpbreakend", value: "Sends the RP break ended notice to the ScreenShare role. (Moderator only)", inline: false },
    )
    .setFooter({ text: "ScreenShare Bot • Use !help anytime" });
}
