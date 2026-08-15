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
