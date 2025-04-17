# Discord TV Channel Bot (BrowserBot Edition)

This bot helps manage and display a TV schedule within your Discord server, but now includes an enhanced **Custom Channel Mode**. It automatically posts schedule updates, manages a corresponding Discord Scheduled Event, and allows users (via polls or admin commands) to switch to a "Custom Channel" where local files or YouTube videos can be played via external scripts (like AutoHotkey).

It integrates with `yt-dlp` for downloading YouTube content, provides an interactive remote control, file browsing, skip voting, and more, making it suitable for managing community streams driven by tools like [VideoScheduler](https://github.com/JasonCampbell256/VideoScheduler), [ErsatzTV](https://github.com/ErsatzTV/ErsatzTV), [DizqueTV](https://github.com/vexorian/dizquetv) or [Tunarr](https://github.com/chrisbenincasa/tunarr), while also offering flexible manual control.

## Core Features

*   **Scheduled Stream Management:**
    *   Automatically posts "Now Playing / Up Next" messages to a designated text channel based on `schedule.js`.
    *   Manages a Discord Scheduled Event, updating its name to reflect the current show (Scheduled Mode) or playing content (Custom Mode).
*   **Custom Channel Mode:**
    *   Allows switching from the schedule to play local files or queued YouTube videos.
    *   Features a "Still Watching?" prompt after a configurable duration.
    *   Detects the currently playing VLC window title (Windows-only) to update the event name.
    *   Requires external scripts (e.g., AutoHotkey) to handle stream switching and file opening.
*   **Interactive Remote (`!remote`):**
    *   Provides buttons for common actions: Now Playing, Refresh, Schedule, Help, Mode Switching, Skipping, YouTube Downloads, File Browsing, Admin Controls.
*   **YouTube Download Queue (`!youtube`, Remote Button):**
    *   Queue YouTube videos or playlists for download using `yt-dlp`.
    *   Supports specifying subfolders for downloads.
    *   Includes progress updates and cancellation (`!cancel`, `!cancelall`, Remote Buttons).
    *   Requires `ffmpeg` for reliable post-processing/re-encoding.
*   **File Browsing (`!browse`, Remote Button):**
    *   Interactive interface to browse downloaded video files within the specified folder.
    *   Supports navigating subfolders and searching within the current directory.
    *   Requires user confirmation via poll before attempting to play a file using an external script.
*   **Polling System:**
    *   Vote to switch between Scheduled (`!ptv`) and Custom (`!custom`) modes.
    *   Vote to skip the current item (`!skip`) in Custom Mode (with bypass for 2 users in VC).
*   **External Script Integration (e.g., AutoHotkey):**
    *   Triggers specific `.ahk` (or other) scripts for:
        *   Refreshing the scheduled stream (`!refresh` in Scheduled Mode).
        *   Refreshing during Custom Mode (`!refresh` in Custom Mode).
        *   Switching *to* Custom Mode.
        *   Switching *back* from Custom Mode.
        *   Skipping the current item in Custom Mode.
        *   Opening a selected file from the browser.
*   **Admin Commands:**
    *   `!toggle`: Force switch between modes *without* running AHK scripts (useful for state correction).
    *   `!clear`: Clear recent bot messages from the current channel.
    *   `!cancelall`: Cancel all active and queued YouTube downloads.
*   **Schedule Viewing (`!schedule`, Remote Button):**
    *   View schedule for Today, This Week, or just Movie listings for the week.
*   **Customizable Schedule:** Define your weekly schedule, including custom messages and images, in `schedule.js`.

## Setup

### Prerequisites:

*   **Node.js:** Version 18.x or newer recommended. Download from [nodejs.org](https://nodejs.org/).
*   **Discord Bot Token:** Create a Bot Application on the [Discord Developer Portal](https://discord.com/developers/applications). Ensure Privileged Gateway Intents are enabled (see below).
*   **Discord Channel IDs:** Enable Developer Mode in Discord (User Settings -> Advanced). Right-click channels/voice channels to copy their IDs for the `.env` configuration.
*   **(Optional but Recommended) AutoHotkey (Windows):** Required if using the `.ahk` script features for stream control, file opening, etc. Download from [www.autohotkey.com](https://www.autohotkey.com/). Ensure it's installed and associated with `.ahk` files on the machine running the bot. For non-Windows, you'd need equivalent scripting solutions and adjust the `runAhkScript` function or replace script execution logic.
*   **(Optional but Recommended) `yt-dlp`:** Required for the `!youtube` command and download queue. Install from [yt-dlp GitHub](https://github.com/yt-dlp/yt-dlp). Ensure the executable is in your system's PATH or provide the full path in `.env`.
*   **(Optional but Recommended) `ffmpeg`:** Required for reliable post-processing (re-encoding) of `yt-dlp` downloads. Download from [ffmpeg.org](https://ffmpeg.org/download.html). Ensure the executable is in your system's PATH or provide the full path in `.env`.

### Project Setup:

1.  **Download/Clone:** Get the bot files (`bot.js`, `schedule.js`, `package.json`, this README).
2.  **Install Dependencies:** Open a terminal/command prompt in the project directory and run:
    ```bash
    npm install
    ```
    *(Installs `discord.js`, `dotenv`, `node-cron`, `yt-dlp-exec`, and `nodemon` for development)*
3.  **Create Scripts:** Create the necessary AutoHotkey (or equivalent) scripts that will be triggered by the bot for refreshing, switching modes, skipping, and opening files.

### Configuration Files:

*   **`.env`:** Replace the placeholders with your own configuration.

*   **`schedule.js`:** Edit this file to define your weekly TV schedule. Use 24-hour format (HH:MM) and days (0=Sunday, ..., 6=Saturday).
    *   Standard entries need `now` and `next` fields (e.g., `"09:00": { now: "Show A", next: "Show B" }`).
    *   You can add an `image` field with a URL for image posts.
    *   You can use `customMessage` for entries that only post text and don't represent a playable show (e.g., `"13:30": { customMessage: "**Reminder:** Server meeting!" }`). These are ignored by `!now` and event name updates.
    *   Mark movies with a prefix like `MOVIE:` in the `now` field if you want the `!schedule` (Movies) view to work (e.g., `"14:00": { now: "MOVIE: Spider-Man", next: "News" }`).

### Discord Bot Permissions & Intents:

*   Go to the Discord Developer Portal -> Your Bot Application -> "Bot" tab.
*   Under "Privileged Gateway Intents", enable:
    *   `PRESENCE INTENT` (Potentially needed by some discord.js v14 features, though often not strictly required unless monitoring user status) - *Check if truly needed, might be optional.*
    *   `SERVER MEMBERS INTENT` (Needed for accurate member/role checks, depending on usage).
    *   **`MESSAGE CONTENT INTENT` (REQUIRED for reading commands like `!now`)**
*   Under "OAuth2" -> "URL Generator", select the `bot` scope and `application.commands` (if planning slash commands later, optional for now).
*   Under "Bot Permissions", select:
    *   `View Channel`
    *   `Send Messages`
    *   `Manage Events` (Crucial for scheduled event updates)
    *   `Connect` (Needed for the event to link to the voice channel)
    *   `Manage Messages` (Needed for `!clear` / remote clear button)
    *   `Read Message History` (Needed for `!clear` / remote clear button)
*   Generate the invite URL and add the bot to your server.
*   **In your Discord Server Settings:** Ensure the bot's **Role** has the necessary permissions listed above, especially in the channels specified in your `.env` file (`DISCORD_CHANNEL_ID`, `TARGET_VOICE_CHANNEL_ID`). `Manage Events` is often a server-wide permission.

## Running the Bot

1.  Open a terminal or command prompt in your project folder.
2.  **For regular use:**
    ```bash
    npm start
    ```
    *(Runs `node bot.js`)*
3.  **For development (auto-restarts on file changes):**
    ```bash
    npm run dev
    ```
    *(Runs `nodemon bot.js`)*
4.  The console will show logs. Keep the terminal window open.
5.  **(Recommended for Production):** Use a process manager like `pm2` to keep the bot running reliably in the background.
    *   Install: `npm install pm2 -g`
    *   Start: `pm2 start bot.js --name "tv-channel-bot"`
    *   Manage: `pm2 list`, `pm2 logs tv-channel-bot`, `pm2 restart tv-channel-bot`, `pm2 stop tv-channel-bot`

## Usage

*   **Primary Interaction:** Use the `!remote` command to get interactive buttons for most actions.
*   **Automatic Actions:**
    *   Schedule posts appear in the `DISCORD_CHANNEL_ID` channel.
    *   The Discord Scheduled Event in `TARGET_VOICE_CHANNEL_ID` updates automatically based on the schedule or Custom Channel activity.
*   **Commands:** (Also accessible via `!remote`)
    *   `!remote`: Show interactive remote control buttons.
    *   `!now`: Display the currently scheduled show or detected VLC title (Custom Mode). Updates event name.
    *   `!refresh`: Trigger the appropriate refresh script (Scheduled or Custom Mode) and update event name.
    *   `!schedule`: Show buttons to view Today's, This Week's, or This Week's Movie schedule.
    *   `!youtube <URL> [Subfolder Name]`: Add a YouTube video/playlist to the download queue. Optionally specify a subfolder within `VIDEO_DOWNLOAD_FOLDER`.
    *   `!help`: Show help information and buttons.
    *   `!custom`: Start a public poll to switch to Custom Channel mode.
    *   `!ptv`: Start a public poll to switch back to the scheduled program.
    *   `!skip`: Start a public poll to skip the current item in Custom Mode. (Bypassed if only 2 non-bot users are in the target voice channel).
    *   `!browse`: Start an interactive file browser for the `VIDEO_DOWNLOAD_FOLDER` (Custom Mode only). Requires poll to play selection.
    *   `!cancel`: Cancel your own active and queued YouTube downloads.
    *   `!clear` (Admin): Delete the bot's messages from the last 12 hours in the current channel.
    *   `!toggle` (Admin): Force switch between Scheduled/Custom modes *without* running AHK scripts.
    *   `!cancelall` (Admin): Cancel *all* active and queued YouTube downloads.
*   **Custom Channel Mode:** Activated via `!custom` poll or `!toggle`. The bot stops following the schedule and relies on VLC title detection (Windows) or manual interaction (`!skip`, `!browse`). A timer prompts users to confirm activity or return to the schedule.
*   **Polls:** Mode switching (`!custom`/`!ptv`), skipping (`!skip`), and file selection (`!browse`) require successful polls (majority vote) unless bypassed (skip) or admin command is used.

## Notes & Troubleshooting
*   **Discord TOS:** Be mindful that automating user actions (like controlling Discord clients via AHK for screensharing) might be against Discord's Terms of Service. Use scripting features responsibly.
*   **AHK/Scripting:** This bot *relies* on external scripts (like AutoHotkey) for core functionality like switching streams, refreshing, skipping, and opening files. Ensure these scripts exist, paths in `.env` are correct, and the bot process has permission to execute them. The bot only triggers the scripts; the scripts themselves must perform the desired actions (e.g., interact with VLC, OBS, etc.).
*   **VLC Title Detection:** This feature is **Windows-only** as it uses the `tasklist` command. It requires VLC media player to be running and displaying a title. The title is cleaned (suffix/extension removed) for event names.
*   **YouTube Downloads:** Requires `yt-dlp` installed and accessible. `ffmpeg` is highly recommended for converting downloads to a compatible format (`.mp4` H.264/AAC by default) and should be configured in `.env` or be in the system PATH. Downloads save to `VIDEO_DOWNLOAD_FOLDER`. Large playlists are limited (`PLAYLIST_VIDEO_LIMIT`).
*   **File Paths:** Double-check all paths in `.env`. Use absolute paths or paths relative to where `bot.js` is executed. Use the correct path separators for your OS (`\` for Windows, `/` for Linux/macOS).
*   **Permissions:** Most issues stem from missing Discord permissions (Intents in Dev Portal, Role permissions in Server Settings) or file system permissions (bot can't read/write/execute files/scripts). Check console logs for `50013` (Discord Permissions) or `EACCES`/`ENOENT` (File System) errors.
*   **Timezones:** `node-cron` scheduling uses the timezone specified in `bot.js` (currently hardcoded to `America/New_York`). Ensure this matches your desired schedule timing or adjust the code.
*   **State:** The bot's mode (`isCustomModeActive`) is stored in memory and resets on restart unless persistence is added. Use `!toggle` if the bot's state gets out of sync with the actual stream state.
*   **Restarting:** Changes to `.env` or `schedule.js` require restarting the bot process (`npm start` or `pm2 restart <name>`).
