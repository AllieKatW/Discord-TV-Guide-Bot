# Discord TV Guide Bot

This bot helps manage and display a TV schedule directly within your Discord server.
It can automatically post schedule updates to a designated text channel and also update the name of a Voice Channel Event to show the current program.
You can also manually trigger a refresh script (I use AutoHotKey but you can use whatever you like) for moments when your stream freezes/crashes.
Recommended for use with projects such as [VideoScheduler](https://github.com/JasonCampbell256/VideoScheduler), [ErsatzTV](https://github.com/ErsatzTV/ErsatzTV), [DisqueTV](https://github.com/vexorian/dizquetv) or [Tunarr](https://github.com/chrisbenincasa/tunarr).

## Features

*   **Automatic Schedule Posting:** Posts messages to a specific text channel based on a defined schedule (e.g., every 30-60 minutes). (ex. `"Now Playing: The Simpsons, Up Next: House"`)
*   **Scheduled Event Updates:** Maintains a Discord Voice Channel Event and automatically updates its name with the "Now Playing" show title according to the schedule.
*   **`!now` Command:** Users can type `!now` in any channel the bot can read to instantly see the current program based on the schedule.
*   **`!refresh` Command:** Runs a script of your choice to automatically refresh/fix your streaming setup when things break and you're not around to fix it manually (ex. Run a .ahk script that force closes your player, reopens it, switches window focus to Discord and triggers Discord keybinds to connect to the Voice Channel of your choice and resume Screen Share). Intended only for use on dedicated streaming machines.
    *   PLEASE NOTE: **This is likely against Discord TOS and can be dangerous if you don't know what you're doing** so I will not be including a sample script. USE AT YOUR OWN DISCRETION. There are no permissions checks in place for this so it can be used by **ANY** user.
*   **Customizable Schedule:** Easily define your weekly schedule (including show titles, images, and custom messages) in a separate file.

## Setup

### Prerequisites:

*   **Node.js:** Ensure you have Node.js (LTS version recommended) installed. Download from [nodejs.org](https://nodejs.org/).
*   **Discord Bot Token:** You need a Bot Application and its Token from the [Discord Developer Portal](https://discord.com/developers/applications). Make sure the bot has the necessary Privileged Gateway Intents enabled (see below).
*   **Discord Channel IDs:** Enable Developer Mode in Discord by visiting your Discord settings and going to "Advanced". You can then right click on any channel and select "Copy ID". You'll need this for the text channel where you want scheduled posts to appear and the voice channel where you want the event to be managed.
*   **AutoHotkey:** If you plan to use the `!refresh` command, AutoHotkey (or your scripting language of choice) must be installed on the machine where the bot script will run, and the script path(s) must be correct.
*   **AutoHotkey Scripts:** Prepare your `.ahk` script(s) that you want the `!refresh` command to execute.

### Project Setup:

*   **Install Dependencies:** Run the following command to install the necessary Node.js libraries:
    ```bash
    npm install
    ```
    *(This installs discord.js for interacting with Discord, node-cron for scheduling, and dotenv for reading the configuration file.)*

### Configuration Files:

*   **`.env`:** Edit the `.env` file in the project root and add your configuration details:
    ```dotenv
    # .env
    DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN_HERE
    DISCORD_CHANNEL_ID=YOUR_TVGUIDE_POST_CHANNEL_ID_HERE
    TARGET_VOICE_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID_HERE
    AHK_SCRIPT_PATH_1=C:\\Path\\To\\Your\\refresh_script.ahk # Use double backslashes or forward slashes
    ```
    *Replace placeholder values with your actual IDs and paths.*

*   **`schedule.js`:** Edit the file named `schedule.js` in the project root and define your TV schedule. Use the 24-hour format (HH:MM) and days (0=Sunday, 1=Monday, ..., 6=Saturday).
*   You can also add images to be posted after the message or use Custom Messages for things like trivia or promotional posts.
    ```javascript
    // schedule.js
    const schedule = {
        // Day 0: Sunday
        0: {
            "09:00": { now: "Morning Cartoons", next: "Sunday News" },
            // ...
        },
        // Day 1: Monday
        1: {
            "10:00": { now: "Morning Show", next: "Cooking Time", image: "https://example.com/images/cooking.png" },
            // ...
        },
        // Day 3: Wednesday
        3: {
            "12:30": { now: "Scrubs", next: "South Park" },
            "13:00": { now: "South Park", next: "Invader Zim" },
            // Example Custom Message (will ONLY be posted, not used for !now or event name)
            "13:30": { customMessage: "**Reminder:** Server meeting at 2PM!" },
            "14:00": { now: "Afternoon Movie", next: "News Update" },
            // ...
        },
        // ... other days (2, 4, 5, 6) ...
    };
    module.exports = schedule;
    ```

### Discord Bot Permissions & Intents:

*   Go to the Discord Developer Portal -> Your Bot Application -> "Bot" tab.
*   Under "Privileged Gateway Intents", ensure **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT** are enabled.
*   Under "OAuth2" -> "URL Generator", select the `bot` scope.
*   Under "Bot Permissions", select:
    *   `View Channel`
    *   `Send Messages`
    *   `Manage Events`
    *   `Connect` (for the Voice Channel Event)
*   Generate the URL and invite the bot to your server with these permissions.
*   Also ensure the bot's role in the server has these permissions at the server level or channel level for the specific target channels.

## Running the Bot

*   Open a terminal or command prompt in your project folder (`discord-tv-guide`).
*   Run the bot using: `node bot.js`
*   The console will show logs as the bot connects, fetches channels, and sets up scheduled tasks. Keep this window open.
*   (Optional) Use a process manager like `pm2` to keep the bot running reliably:
    *   Install pm2: `npm install pm2 -g`
    *   Start the bot: `pm2 start bot.js --name "tv-guide-bot"`
    *   Monitor: `pm2 list` or `pm2 logs tv-guide-bot`
    *   Stop: `pm2 stop tv-guide-bot`

## Usage

*   **Automatic Posts:** The bot will automatically post schedule updates to the channel specified by `DISCORD_CHANNEL_ID` according to the `schedule.js` file.
*   **Event Name Updates:** The bot will automatically update the name of the Guild Scheduled Event linked to the voice channel specified by `TARGET_VOICE_CHANNEL_ID` whenever a new "Now Playing" show starts according to the schedule.
*   **`!now` Command:**
    *   Type `!now` in any channel the bot can read.
    *   The bot will reply with the "Now Playing" and "Up Next" information for the schedule slot closest to the current time. It will ignore any `customMessage` entries in the schedule for this command.
*   **`!refresh` Command:**
    *   Type `!refresh` in any channel the bot can read.
    *   The bot will:
        1.  Reply with a confirmation message.
        2.  Update the Voice Channel Event name based on the current "Now Playing" schedule.
        3.  Run the AutoHotkey script specified by `AHK_SCRIPT_PATH_1`.
        4.  Reply with status updates during the process.

## Notes & Troubleshooting

*   **Timezones:** The bot uses the local timezone of the machine it's running on. If your schedule is based on a different timezone, you might need to adjust the cron settings or use timezone handling in Node.js.
*   **Schedule Changes:** If you modify `schedule.js` or `.env`, you must restart the `node bot.js` process (or use `pm2 restart tv-guide-bot` if you have `pm2` set up) for the changes to take effect.
*   **Permissions:** Most issues arise from missing permissions. Double-check that the bot has `View Channel`, `Send Messages`, `Manage Events`, and `Connect` permissions at the server or channel level, as needed.
*   **Event Management:** The bot tries to manage one persistent event. If you manually delete the event created by the bot, it will create a new one on the next schedule trigger or `!refresh` command.
*   **AHK Scripts:** Ensure the paths in `.env` are correct and the Node.js process has permission to execute those `.ahk` files. If you encounter errors during script execution, check the console logs for specific details provided by the `exec` function.
*   **Error Messages:** If you see error messages in the console, review them carefully. They often provide specific Discord API error codes or hints about permission issues (`50013` is a common permission error).
