# ScreenShare Bot

Discord moderation bot for the ScreenShare server.

## Setup

1. Copy `.env.example` to `.env` and fill in your values:
   ```
   cp .env.example .env
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Build and start:
   ```
   npm run build
   npm start
   ```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Your bot token from Discord Developer Portal |
| `MODERATOR_ROLE_ID` | ✅ | Role ID that can use mod commands |
| `ROLE_APPROVAL_CHANNEL_ID` | ✅ | Channel ID where role requests appear |
| `WELCOME_CHANNEL_ID` | ✅ | Channel ID for welcome messages |
| `COMMAND_PREFIX` | ❌ | Default: `!` |
| `MODERATOR_ROLE_NAME` | ❌ | Default: `moderator` |

## Commands

| Command | Description |
|---|---|
| `!setuprolebutton` | Posts the role request embed with button (mod only) |
| `!addcargo @role userId` | Adds a role to a user (mod only) |
| `!remcargo @role userId` | Removes a role from a user (mod only) |
| `!rpbreak` | DMs all ScreenShare members about an RP break (mod only) |
| `!rpbreakend` | DMs all ScreenShare members that the RP break is lifted (mod only) |

## Hosting on Railway (Free)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) and create a new project
3. Connect your GitHub repo
4. Add your environment variables in Railway's dashboard
5. Railway will build and run the bot automatically — no sleeping!

## Assets

The `assets/` folder contains the images used for `!rpbreak` and `!rpbreakend` DMs.
Keep them in the root of the project when deployed.
