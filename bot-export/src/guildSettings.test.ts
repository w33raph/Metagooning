import test from "node:test";
import assert from "node:assert/strict";
import { getGuildSettings, setGuildSetting, setGuildSettings, clearGuildSettings } from "./guildSettings";

test("stores per-guild welcome and approval channels independently", () => {
  clearGuildSettings();

  setGuildSetting("guild-1", "welcomeChannelId", "welcome-1");
  setGuildSetting("guild-1", "roleApprovalChannelId", "approval-1");
  setGuildSetting("guild-2", "welcomeChannelId", "welcome-2");
  setGuildSetting("guild-1", "botCommandRoleIds", ["role-1", "role-2"]);

  const guild1 = getGuildSettings("guild-1");
  const guild2 = getGuildSettings("guild-2");

  assert.equal(guild1.welcomeChannelId, "welcome-1");
  assert.equal(guild1.roleApprovalChannelId, "approval-1");
  assert.deepEqual(guild1.botCommandRoleIds, ["role-1", "role-2"]);
  assert.equal(guild2.welcomeChannelId, "welcome-2");
  assert.equal(guild2.roleApprovalChannelId, undefined);

  setGuildSettings("guild-1", { welcomeChannelId: "welcome-3" });
  assert.equal(getGuildSettings("guild-1").welcomeChannelId, "welcome-3");

  clearGuildSettings();
});
