export interface WelcomeChannelLike {
  id: string;
  isTextBased(): boolean;
  send(...args: unknown[]): Promise<unknown>;
}

export function resolveWelcomeChannel(
  configuredChannelId: string | undefined,
  availableChannels: WelcomeChannelLike[],
  systemChannel?: WelcomeChannelLike | null,
): WelcomeChannelLike | null {
  if (configuredChannelId) {
    const configured = availableChannels.find((channel) => channel.id === configuredChannelId && channel.isTextBased());
    if (configured) return configured;
  }

  if (systemChannel?.isTextBased()) return systemChannel;

  return availableChannels.find((channel) => channel.isTextBased()) ?? null;
}
